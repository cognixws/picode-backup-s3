// The door against a small in-memory S3 that misbehaves the ways real ones
// do: it ignores Range, it answers errors with words of its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { request } from "node:http";
import { runConformance } from "./conformance.mjs";
import { storage } from "./helpers.mjs";
import { config } from "../lib/settings.mjs";

function fakeS3({ words = false, endless = false, v1 = false } = {}) {
  const objects = new Map();
  const seen = { lists: 0, puts: 0, requests: [] };
  const fail = (res, code) => { res.writeHead(code, { "Content-Type": "application/xml" }); res.end(words ? "<Error><Message>SECRET-STORAGE-WORDS</Message></Error>" : ""); };
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, "http://s3");
      const [, bucket, ...rest] = url.pathname.split("/");
      const key = decodeURIComponent(rest.join("/"));
      seen.requests.push(req);
      if (bucket !== "fake") return fail(res, 404);
      if (req.method === "GET" && !key && (endless || v1)) {
        seen.lists++;
        const page = url.searchParams.get("continuation-token") || "0";
        const prefix = url.searchParams.get("prefix") || "";
        let xml = "<ListBucketResult><IsTruncated>true</IsTruncated>";
        for (let i = 0; i < 1000; i++) {
          const name = createHash("sha256").update(page + ":" + i).digest("hex");
          xml += `<Contents><Key>${prefix}${name}</Key><Size>1</Size></Contents>`;
        }
        if (!v1) xml += `<NextContinuationToken>${Number(page) + 1}</NextContinuationToken>`;
        res.writeHead(200, { "Content-Type": "application/xml" });
        return res.end(xml + "</ListBucketResult>");
      }
      if (req.method === "GET" && !key) {
        const prefix = url.searchParams.get("prefix") || "", delim = url.searchParams.get("delimiter");
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const common = new Set();
        let xml = "<ListBucketResult><IsTruncated>false</IsTruncated>";
        for (const k of keys) {
          const tail = k.slice(prefix.length);
          if (delim && tail.includes(delim)) { common.add(prefix + tail.slice(0, tail.indexOf(delim) + 1)); continue; }
          xml += `<Contents><Key>${k}</Key><Size>${objects.get(k).length}</Size></Contents>`;
        }
        for (const p of common) xml += `<CommonPrefixes><Prefix>${p}</Prefix></CommonPrefixes>`;
        res.writeHead(200, { "Content-Type": "application/xml" });
        return res.end(xml + "</ListBucketResult>");
      }
      if (req.method === "PUT") {
        seen.puts++;
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => { objects.set(key, Buffer.concat(chunks)); res.writeHead(200); res.end(); });
        req.on("aborted", () => {});
        return;
      }
      const obj = objects.get(key);
      if (!obj) return fail(res, 404);
      if (req.method === "HEAD") { res.writeHead(200, { "Content-Length": obj.length }); return res.end(); }
      if (req.method === "GET") { res.writeHead(200, { "Content-Length": obj.length }); return res.end(obj); } // Range ignored
      if (req.method === "DELETE") { objects.delete(key); res.writeHead(204); return res.end(); }
      fail(res, 405);
    }).listen(0, "127.0.0.1", () => { server.seen = seen; resolve(server); });
  });
}

const settingsFor = (port, over = {}) => ({
  values: { endpoint: `http://127.0.0.1:${port}`, bucket: "fake", region: "us-east-1", ...over },
  secrets: { access_key_id: "k", secret_access_key: "s" },
});

test("a storage that ignores Range still answers 206 with exactly the bytes asked", { timeout: 120_000 }, async () => {
  const s3 = await fakeS3();
  const s = await storage(settingsFor(s3.address().port));
  try {
    const c = (await s.status()).connections[0];
    const { passed, failed } = await runConformance({ base: `${s.url}/repo/${c.id}/cognix-x`, secret: s.secret, status: s.url + "/status", log: () => {} });
    assert.deepEqual(failed, [], `${passed} passed`);
    const auth = { Authorization: "Basic " + Buffer.from("picode:" + s.secret).toString("base64") };
    const res = await fetch(`${s.url}/repo/${c.id}/cognix-x/config`, { headers: { ...auth, Range: "bytes=500-" } });
    assert.equal(res.status, 416);
  } finally { s.stop(); s3.close(); }
});

test("only a status code reaches COGNIX[WS], never the storage's words", { timeout: 60_000 }, async () => {
  const s3 = await fakeS3({ words: true });
  const s = await storage(settingsFor(s3.address().port, { bucket: "fake" }));
  try {
    const c = (await s.status()).connections[0];
    const auth = { Authorization: "Basic " + Buffer.from("picode:" + s.secret).toString("base64") };
    for (const path of ["/config", "/keys/" + "a".repeat(64)]) {
      const res = await fetch(`${s.url}/repo/${c.id}/r${path}`, { headers: auth });
      assert.equal(res.status, 404);
      assert.ok(!(await res.text()).includes("SECRET"), "the storage's words leaked");
    }
  } finally { s.stop(); s3.close(); }
  const other = await fakeS3({ words: true });
  const wrong = await storage(settingsFor(other.address().port, { bucket: "missing-bucket" }));
  try {
    const st = await wrong.status();
    assert.deepEqual(st, { state: "needs-attention", next: "settings", connections: [] });
  } finally { wrong.stop(); other.close(); }
});

test("a body that is not its name is never stored", { timeout: 60_000 }, async () => {
  const s3 = await fakeS3();
  const s = await storage(settingsFor(s3.address().port));
  try {
    const c = (await s.status()).connections[0];
    const auth = { Authorization: "Basic " + Buffer.from("picode:" + s.secret).toString("base64") };
    const url = `${s.url}/repo/${c.id}/r/data/${"b".repeat(64)}`;
    const res = await fetch(url, { method: "POST", headers: auth, body: randomBytes(100_000) });
    assert.equal(res.status, 400);
    assert.equal((await fetch(url, { method: "HEAD", headers: auth })).status, 404);
  } finally { s.stop(); s3.close(); }
});

const settingsId = (port) => config(settingsFor(port)).connection;
const basic = (secret) => ({ Authorization: "Basic " + Buffer.from("picode:" + secret).toString("base64") });

test("the settings check never lends the saved key to another address or bucket", { timeout: 60_000 }, async () => {
  const s3 = await fakeS3();
  const elsewhere = await fakeS3();
  const s = await storage(settingsFor(s3.address().port));
  try {
    const check = (values, secrets = {}) => fetch(s.url + "/settings/check", { method: "POST", headers: { "X-PiCode-Proxy-Secret": s.secret, "Content-Type": "application/json" }, body: JSON.stringify({ values, secrets }) });
    for (const values of [{ endpoint: `http://127.0.0.1:${elsewhere.address().port}` }, { bucket: "another-bucket" }]) {
      const res = await check(values);
      assert.equal(res.status, 400);
      assert.match((await res.json()).message, /Enter the access key again/);
    }
    assert.equal(elsewhere.seen.requests.length, 0, "the other server was reached with the saved key");
    const same = await check({ region: "us-east-1" });
    assert.equal(same.status, 200, "the saved place with the saved key is checked");
    const fresh = await check({ endpoint: `http://127.0.0.1:${elsewhere.address().port}` }, { access_key_id: "new", secret_access_key: "new" });
    assert.equal(fresh.status, 200, "a new key for a new place is checked there");
    assert.ok(elsewhere.seen.requests.length > 0);
  } finally { s.stop(); s3.close(); elsewhere.close(); }
});

test("cancelled uploads give their sockets back at once", { timeout: 60_000 }, async () => {
  const s3 = await fakeS3();
  const s = await storage(settingsFor(s3.address().port));
  try {
    const c = (await s.status()).connections[0];
    const base = `${s.url}/repo/${c.id}/r/data/`;
    await Promise.all(Array.from({ length: 20 }, (_, i) => new Promise((resolve) => {
      const name = createHash("sha256").update("cancel" + i).digest("hex");
      const req = request(base + name, { method: "POST", headers: { ...basic(s.secret), "Content-Length": 4 << 20 } });
      req.on("error", () => resolve());
      req.write(randomBytes(1 << 16));
      setTimeout(() => { req.destroy(); resolve(); }, 300);
    })));
    const body = randomBytes(1000);
    const t = Date.now();
    const res = await fetch(base + createHash("sha256").update(body).digest("hex"), { method: "POST", headers: basic(s.secret), body });
    assert.equal(res.status, 200);
    assert.ok(Date.now() - t < 3000, "the next upload waited " + (Date.now() - t) + " ms");
  } finally { s.stop(); s3.close(); }
});

test("a listing stops when COGNIX[WS] stops reading it", { timeout: 60_000 }, async () => {
  const s3 = await fakeS3({ endless: true });
  const s = await storage(settingsFor(s3.address().port));
  try {
    const c = { id: settingsId(s3.address().port) };
    // Both ways a reader leaves: after the listing began (keys, whose names
    // all match), and before a single entry matched (data, in no layout).
    for (const type of ["keys", "data"]) {
      const ac = new AbortController();
      const done = fetch(`${s.url}/repo/${c.id}/r/${type}/`, { headers: { ...basic(s.secret), Accept: "application/vnd.x.restic.rest.v2" }, signal: ac.signal })
        .then((res) => res.body.getReader().read()).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      ac.abort();
      await done;
    }
    await new Promise((r) => setTimeout(r, 300));
    const at = s3.seen.lists;
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(s3.seen.lists - at <= 2, `${s3.seen.lists - at} more pages were fetched after the reader left`);
  } finally { s.stop(); s3.close(); }
});

test("a truncated listing with no way on is an error, not a short list", { timeout: 60_000 }, async () => {
  const s3 = await fakeS3({ v1: true });
  const s = await storage(settingsFor(s3.address().port));
  try {
    const id = settingsId(s3.address().port);
    const res = await fetch(`${s.url}/repo/${id}/r/keys/`, { headers: { ...basic(s.secret), Accept: "application/vnd.x.restic.rest.v2" } });
    let failed = res.status === 502;
    if (!failed) { try { await res.text(); } catch { failed = true; } }
    assert.ok(failed, "a listing that could not go on answered " + res.status);
  } finally { s.stop(); s3.close(); }
});
