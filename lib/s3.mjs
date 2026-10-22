// A small S3 client: the requests a backup repository needs, signed with
// SigV4, bodies streamed both ways. Answers are handed back raw; the door
// decides what they mean and never passes the storage's words on.
import http from "node:http";
import https from "node:https";
import { EMPTY_SHA256, encode, sign } from "./sigv4.mjs";

const agents = { "http:": new http.Agent({ keepAlive: true, maxSockets: 16 }), "https:": new https.Agent({ keepAlive: true, maxSockets: 16 }) };

export class S3 {
  constructor(cfg, { timeoutMs = 60_000 } = {}) {
    this.cfg = cfg;
    this.timeoutMs = timeoutMs;
  }

  // request sends one signed request. key is the object's key ("" for the
  // bucket); body is a readable stream (with contentLength) or a Buffer.
  request(method, key, { query = {}, headers = {}, body, contentLength, payloadHash = EMPTY_SHA256 } = {}) {
    const { endpoint, bucket, virtual } = this.cfg;
    const host = virtual ? `${bucket}.${endpoint.host}` : endpoint.host;
    const path = virtual ? "/" + encode(key, true) : "/" + encode(bucket) + (key ? "/" + encode(key, true) : "");
    const signed = sign({ method, host, path, query, payloadHash, accessKeyId: this.cfg.accessKeyId, secretAccessKey: this.cfg.secretAccessKey, region: this.cfg.region });
    const search = Object.keys(query).sort().map((k) => encode(k) + "=" + encode(query[k])).join("&");
    const transport = endpoint.protocol === "https:" ? https : http;
    return new Promise((resolve, reject) => {
      const req = transport.request({
        protocol: endpoint.protocol, hostname: virtual ? `${bucket}.${endpoint.hostname}` : endpoint.hostname, port: endpoint.port || undefined,
        method, path: path + (search ? "?" + search : ""), agent: agents[endpoint.protocol], timeout: this.timeoutMs, // connecting included
        headers: { ...headers, ...signed, host, ...(contentLength !== undefined ? { "content-length": contentLength } : {}) },
      }, resolve);
      req.setTimeout(this.timeoutMs, () => req.destroy(new Error("timeout")));
      req.on("error", reject);
      if (Buffer.isBuffer(body)) req.end(body);
      else if (body) {
        body.on("error", (e) => req.destroy(e));
        req.on("error", () => body.destroy?.());
        body.pipe(req);
      } else req.end();
    });
  }

  // list yields every object under prefix as {key, size}, a page at a time.
  async *list(prefix, { delimiter } = {}) {
    let token = "";
    for (let pages = 0; pages < 100_000; pages++) {
      const query = { "list-type": "2", prefix, "max-keys": "1000" };
      if (delimiter) query.delimiter = delimiter;
      if (token) query["continuation-token"] = token;
      const res = await this.request("GET", "", { query });
      const text = await readText(res, 8 << 20);
      if (res.statusCode !== 200) throw new StorageError(res.statusCode);
      for (const m of text.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = unescapeXML(/<Key>([\s\S]*?)<\/Key>/.exec(m[1])?.[1] || "");
        const size = Number(/<Size>(\d+)<\/Size>/.exec(m[1])?.[1]);
        if (key && Number.isSafeInteger(size)) yield { key, size };
      }
      for (const m of text.matchAll(/<CommonPrefixes>\s*<Prefix>([\s\S]*?)<\/Prefix>\s*<\/CommonPrefixes>/g)) yield { prefix: unescapeXML(m[1]) };
      if (!/<IsTruncated>true<\/IsTruncated>/.test(text)) return;
      token = unescapeXML(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(text)?.[1] || "");
      // Truncated without a way on (a server that speaks only list v1): a
      // short listing would read as missing objects, so it is an error.
      if (!token) throw new StorageError(502);
    }
  }
}

// StorageError carries only the storage's status code (0 when it did not
// answer), never its words.
export class StorageError extends Error {
  constructor(status) { super(status ? `the storage answered ${status}` : "the storage did not answer"); this.status = status; }
}

export function readText(res, limit = 1 << 20) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    res.on("data", (c) => { size += c.length; if (size <= limit) chunks.push(c); });
    res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    res.on("error", () => resolve(""));
  });
}

export function drain(res) {
  res.resume();
  return new Promise((r) => { res.on("end", r); res.on("error", r); res.on("close", r); });
}

function unescapeXML(s) {
  return s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-fA-F]+);/g, (_, e) => {
    switch (e) {
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return '"';
      case "apos": return "'";
      case "amp": return "&";
    }
    try { return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)); } catch { return ""; }
  });
}
