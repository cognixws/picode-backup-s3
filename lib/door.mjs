// The storage door COGNIX[WS] calls (ADR-0368, decision 10): restic's REST
// protocol, version 2, under /repo/{connection}/{repository}/, kept in an S3
// bucket with restic's own layout, and the closed status at /status.
//
// The core encrypts and names every object by the SHA-256 of its bytes, so
// each upload is signed with that hash (AWS and R2 refuse a body that does
// not match) and checked here as it streams: the last piece is held back
// until the hash matches, so no server keeps a body that is not its name.
// Nothing the storage says reaches the core but a status code.
import { createHash } from "node:crypto";
import { once } from "node:events";
import { Transform, pipeline } from "node:stream";
import { S3, StorageError, drain } from "./s3.mjs";

const TYPES = new Set(["data", "index", "snapshots", "keys", "locks"]);
const NAME = /^[0-9a-f]{64}$/;
const SEGMENT = /^[A-Za-z0-9_-]{1,96}$/;
const MAX_OBJECT = 64 << 20;
const MAX_CONFIG = 1 << 20;
const V2 = "application/vnd.x.restic.rest.v2";

export function send(res, code, body = "", type = "text/plain") {
  if (res.headersSent) return res.destroy();
  res.writeHead(code, { "Content-Type": type, "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
  res.end(body);
}

// hashed passes a body through, holding its last piece until the whole
// body's SHA-256 is name; otherwise it fails, and the upload never ends.
export function hashed(name) {
  const h = createHash("sha256");
  let held = null;
  return new Transform({
    transform(chunk, _, done) {
      h.update(chunk);
      const out = held;
      held = chunk;
      done(null, out || undefined);
    },
    flush(done) {
      if (h.digest("hex") !== name) return done(new Error("the body is not its name"));
      done(null, held || undefined);
    },
  });
}

export class Door {
  // settings() answers the current config (lib/settings.mjs) or null.
  constructor({ settings, client = (cfg) => new S3(cfg), statusTTL = 30_000, statusWaitMs = 2_500 }) {
    this.settings = settings;
    this.client = client;
    this.statusTTL = statusTTL;
    this.statusWaitMs = statusWaitMs;
    this.cached = null;
    this.inflight = null;
  }

  base(cfg, repo) { return (cfg.prefix ? cfg.prefix + "/" : "") + repo + "/"; }

  key(cfg, repo, type, name) {
    return this.base(cfg, repo) + (type === "data" ? `data/${name.slice(0, 2)}/${name}` : `${type}/${name}`);
  }

  async status() {
    let cfg;
    try { cfg = await this.settings(); } catch { return { state: "needs-attention", next: "retry", connections: [] }; }
    if (!cfg) return { state: "needs-setup", next: "settings", connections: [] };
    if (this.cached && this.cached.cfg === cfg && Date.now() - this.cached.at < (this.cached.value.state === "ready" ? this.statusTTL : 5_000)) return this.cached.value;
    if (!this.inflight) {
      this.inflight = this.probe(cfg).then((value) => {
        this.cached = { cfg, at: Date.now(), value };
        return value;
      }).finally(() => { this.inflight = null; });
    }
    // COGNIX[WS] waits three seconds for a status: a slow storage answers
    // what was last known, and the probe goes on to be read next time.
    const late = new Promise((r) => setTimeout(() => r(null), this.statusWaitMs).unref());
    const value = await Promise.race([this.inflight, late]);
    if (value) return value;
    if (this.cached && this.cached.cfg === cfg) return this.cached.value;
    return { state: "needs-attention", next: "retry", connections: [] };
  }

  // probe lists the bucket's top folder under the prefix: it proves the key
  // and the bucket and names the repositories already there.
  async probe(cfg) {
    const repositories = [];
    try {
      const s3 = new S3(cfg, { timeoutMs: 10_000 });
      const base = cfg.prefix ? cfg.prefix + "/" : "";
      const candidates = [];
      for await (const e of s3.list(base, { delimiter: "/" })) {
        if (!e.prefix) continue;
        const name = e.prefix.slice(base.length).replace(/\/$/, "");
        if (SEGMENT.test(name) && candidates.length < 64) candidates.push(name);
      }
      // Only folders holding a repository's config are repositories.
      for (const name of candidates) if ((await this.head(s3, base + name + "/config")) >= 0) repositories.push(name);
    } catch (e) {
      const code = e instanceof StorageError ? e.status : 0;
      // A refused key, a missing bucket or a wrong region is the person's to
      // fix in the settings; an outage is retried.
      const settings = code === 400 || code === 401 || code === 403 || code === 404 || code === 301;
      return { state: "needs-attention", next: settings ? "settings" : "retry", connections: [] };
    }
    return { state: "ready", connections: [{ id: cfg.connection, label: cfg.label, deleteAllowed: !cfg.neverDelete, repositories }] };
  }

  async handle(req, res, connection, repo, rest) {
    const cfg = await this.settings();
    if (!cfg || connection !== cfg.connection || !SEGMENT.test(repo)) return send(res, 404, "not found");
    const s3 = this.client(cfg);
    const url = new URL(req.url, "http://storage");
    if (rest === "/" && req.method === "POST" && url.searchParams.get("create") === "true") return this.create(res, s3, cfg, repo);
    if (rest === "/config") {
      const key = this.base(cfg, repo) + "config";
      if (req.method === "POST") return this.writeConfig(req, res, s3, key);
      if (req.method === "GET" || req.method === "HEAD") return this.read(req, res, s3, key);
      return send(res, 405, "method");
    }
    const parts = rest.split("/").slice(1);
    const type = parts[0];
    if (!TYPES.has(type)) return send(res, 404, "not found");
    if (parts.length === 2 && parts[1] === "" && req.method === "GET") {
      if (!(req.headers.accept || "").includes(V2)) return send(res, 400, "REST version 2 only");
      return this.list(res, s3, cfg, repo, type);
    }
    if (parts.length !== 2 || !NAME.test(parts[1])) return send(res, 404, "not found");
    const key = this.key(cfg, repo, type, parts[1]);
    switch (req.method) {
      case "HEAD":
      case "GET":
        return this.read(req, res, s3, key);
      case "POST":
        return this.write(req, res, s3, key, parts[1]);
      case "DELETE":
        return this.remove(res, s3, cfg, key);
    }
    return send(res, 405, "method");
  }

  // S3 has no folders: creating a repository proves the bucket answers.
  async create(res, s3, cfg, repo) {
    const r = await s3.request("GET", "", { query: { "list-type": "2", prefix: this.base(cfg, repo), "max-keys": "1" } });
    await drain(r);
    return send(res, r.statusCode === 200 ? 200 : 502, r.statusCode === 200 ? "" : "storage error");
  }

  async head(s3, key) {
    const r = await s3.request("HEAD", key);
    await drain(r);
    if (r.statusCode === 200) return Number(r.headers["content-length"]);
    if (r.statusCode === 404) return -1;
    throw new StorageError(r.statusCode);
  }

  async write(req, res, s3, key, name) {
    const size = Number(req.headers["content-length"]);
    if (!(Number.isSafeInteger(size) && size >= 0 && size <= MAX_OBJECT)) return send(res, 400, "size");
    const have = await this.head(s3, key);
    if (have >= 0) {
      req.resume();
      // A name is the hash of its content: the same size is the same object.
      return have === size ? send(res, 200) : send(res, 403, "exists");
    }
    let r;
    try {
      // pipeline passes a cancelled upload on: the PUT ends at once and its
      // socket goes back to the pool (a capture pauses copies often).
      const body = pipeline(req, hashed(name), () => {});
      r = await s3.request("PUT", key, { body, contentLength: size, payloadHash: name, headers: { "content-type": "application/octet-stream" } });
    } catch {
      return send(res, 400, "body");
    }
    await drain(r);
    if (r.statusCode === 200) return send(res, 200);
    // S3 refuses a body whose hash is not its name (400): the core sent
    // something else, or the bytes were damaged on the way.
    return send(res, r.statusCode === 400 ? 400 : 502, "storage error");
  }

  async writeConfig(req, res, s3, key) {
    const size = Number(req.headers["content-length"]);
    if (!(Number.isSafeInteger(size) && size >= 0 && size <= MAX_CONFIG)) return send(res, 400, "size");
    const chunks = [];
    let got = 0;
    for await (const c of req) { got += c.length; if (got > size) return send(res, 400, "body"); chunks.push(c); }
    if (got !== size) return send(res, 400, "body");
    const body = Buffer.concat(chunks);
    const have = await this.head(s3, key);
    if (have >= 0) return have === size ? send(res, 200) : send(res, 403, "exists");
    const r = await s3.request("PUT", key, { body, contentLength: size, payloadHash: createHash("sha256").update(body).digest("hex"), headers: { "content-type": "application/octet-stream" } });
    await drain(r);
    return send(res, r.statusCode === 200 ? 200 : 502, r.statusCode === 200 ? "" : "storage error");
  }

  async read(req, res, s3, key) {
    const head = req.method === "HEAD";
    const range = req.headers.range;
    if (range !== undefined && !/^bytes=\d+-\d*$/.test(range)) return send(res, 416, "range");
    const r = await s3.request(head ? "HEAD" : "GET", key, { headers: range && !head ? { range } : {} });
    if (r.statusCode === 404) { await drain(r); return send(res, 404, "not found"); }
    if (r.statusCode === 416) {
      await drain(r);
      res.writeHead(416, { "Content-Range": /^bytes \*\/\d+$/.test(r.headers["content-range"] || "") ? r.headers["content-range"] : "bytes */0" });
      return res.end();
    }
    if (r.statusCode !== 200 && r.statusCode !== 206) { await drain(r); return send(res, 502, "storage error"); }
    // Some S3 servers answer a range with 200: with the range's bytes and
    // Content-Range (rclone), or with the whole object, which the door cuts
    // itself. Either way the core gets 206.
    const ranged = /^bytes \d+-\d+\/\d+$/.test(r.headers["content-range"] || "");
    if (range && !head && r.statusCode === 200 && !ranged) return this.cut(res, r, range);
    const code = range && !head && ranged ? 206 : r.statusCode;
    const headers = { "Content-Type": "application/octet-stream" };
    if (/^\d+$/.test(r.headers["content-length"] || "")) headers["Content-Length"] = r.headers["content-length"];
    if (code === 206) {
      if (!ranged) { r.destroy(); return send(res, 502, "storage error"); }
      headers["Content-Range"] = r.headers["content-range"];
    }
    res.writeHead(code, headers);
    if (head) { await drain(r); return res.end(); }
    // A read the core stops halfway (a capture pauses a copy) ends only that
    // response and the storage's.
    res.on("close", () => { if (!res.writableFinished) r.destroy(); });
    r.on("error", () => res.destroy());
    r.pipe(res);
  }

  cut(res, r, range) {
    const total = Number(r.headers["content-length"]);
    const [, a, b] = /^bytes=(\d+)-(\d*)$/.exec(range);
    const start = Number(a), end = b === "" ? total - 1 : Math.min(Number(b), total - 1);
    if (!Number.isSafeInteger(total) || start >= total || end < start) {
      r.destroy();
      res.writeHead(416, { "Content-Range": "bytes */" + (Number.isSafeInteger(total) ? total : 0) });
      return res.end();
    }
    res.writeHead(206, { "Content-Type": "application/octet-stream", "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${total}` });
    let at = 0;
    res.on("close", () => { if (!res.writableFinished) r.destroy(); });
    r.on("error", () => res.destroy());
    r.on("data", (chunk) => {
      const from = Math.max(start - at, 0), to = Math.min(end + 1 - at, chunk.length);
      at += chunk.length;
      if (to > from && !res.write(chunk.subarray(from, to))) { r.pause(); res.once("drain", () => r.resume()); }
      if (at > end) { r.destroy(); res.end(); }
    });
    r.on("end", () => { if (!res.writableEnded) res.destroy(); });
  }

  async remove(res, s3, cfg, key) {
    if (cfg.neverDelete) return send(res, 403, "append-only");
    if ((await this.head(s3, key)) < 0) return send(res, 404, "not found");
    const r = await s3.request("DELETE", key);
    await drain(r);
    if (r.statusCode === 200 || r.statusCode === 204) return send(res, 200);
    // A key without the right to delete is a storage that keeps everything.
    return send(res, r.statusCode === 403 ? 403 : 502, "storage error");
  }

  async list(res, s3, cfg, repo, type) {
    const prefix = this.base(cfg, repo) + type + "/";
    let open = false;
    try {
      for await (const e of s3.list(prefix)) {
        if (res.destroyed) return; // the reader left: stop walking the bucket
        if (!e.key) continue;
        const rest = e.key.slice(prefix.length);
        const m = type === "data" ? /^([0-9a-f]{2})\/([0-9a-f]{64})$/.exec(rest) : null;
        const name = type === "data" ? (m && m[1] === m[2].slice(0, 2) ? m[2] : "") : rest;
        if (!NAME.test(name)) continue;
        // A slow reader slows the walk.
        let room;
        if (!open) { res.writeHead(200, { "Content-Type": V2, "Cache-Control": "no-store" }); room = res.write("[" + JSON.stringify({ name, size: e.size })); open = true; }
        else room = res.write("," + JSON.stringify({ name, size: e.size }));
        if (!room && !res.destroyed) await Promise.race([once(res, "drain"), once(res, "close")]);
      }
    } catch {
      return open ? res.destroy() : send(res, 502, "storage error");
    }
    if (!open) return send(res, 200, "[]", V2);
    res.end("]");
  }
}

