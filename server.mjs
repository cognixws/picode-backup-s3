// S3-compatible backup storage for COGNIX[WS] (ADR-0368): Cloudflare R2,
// Backblaze B2, Wasabi, MinIO, AWS S3 and any storage that speaks S3. The
// core encrypts every object before it reaches this process; the bucket
// holds only encrypted copies.
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Door, send } from "./lib/door.mjs";
import { HostAPI } from "./lib/host.mjs";
import { checkSettings, config, parseEndpoint } from "./lib/settings.mjs";

const required = ["PICODE_URL", "PICODE_EXT_TOKEN", "PICODE_EXT_DATA", "PICODE_EXT_PORT", "PICODE_EXT_PROXY_SECRET"];
if (Number(process.versions.node.split(".")[0]) < 22 || required.some((k) => !process.env[k])) {
  console.error("Start this storage from COGNIX[WS] (Node.js 22 or newer).");
  process.exit(1);
}
const secret = process.env.PICODE_EXT_PROXY_SECRET;
const host = new HostAPI({ url: process.env.PICODE_URL, token: process.env.PICODE_EXT_TOKEN, dataDir: process.env.PICODE_EXT_DATA });

// Saving the settings restarts this process, so they are read once; a host
// that did not answer yet is asked again on the next request.
let current;
async function settings() {
  if (current === undefined) current = config(await host.request("/api/ext/v1/settings")); // throws while the host does not answer
  return current;
}

const door = new Door({ settings });

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
// The core sends the relay's secret as a header and as Basic picode:<secret>.
// The repositories ask for Basic: a page's relay sends only the header and
// must never reach them (ADR-0368, decision 13).
function basicOK(req) {
  const basic = /^Basic (.+)$/.exec(req.headers.authorization || "");
  return !!basic && same(Buffer.from(basic[1], "base64").toString(), "picode:" + secret);
}
function allowed(req, repositoryRoute) {
  if (repositoryRoute) return basicOK(req);
  return same(req.headers["x-picode-proxy-secret"] || "", secret) || basicOK(req);
}

async function readJSON(req, limit = 16 << 10) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) return undefined; chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return undefined; }
}

// The settings check proves the key and bucket before anything is saved; a
// secret that did not change is absent and the saved one is used.
async function check(req, res) {
  const body = await readJSON(req);
  if (body === undefined) return send(res, 400, JSON.stringify({ message: "This request could not be read." }), "application/json");
  try { checkSettings(body); } catch (e) { return send(res, 400, JSON.stringify({ message: e.message }), "application/json"); }
  let saved = { values: {}, secrets: {} };
  try { saved = (await host.request("/api/ext/v1/settings")) || saved; } catch { /* nothing saved yet */ }
  const values = { ...saved.values, ...body.values };
  // The saved key only ever goes to the saved address and bucket: the check
  // answers anyone holding the relay's secret (a page's relay too), and it
  // must not lend the key to another server or turn into a bucket oracle.
  const before = config(saved);
  const samePlace = !!before && String(values.bucket || "").trim() === before.bucket && parseEndpoint(values.endpoint)?.origin === before.endpoint.origin;
  const secrets = samePlace ? { ...saved.secrets, ...body.secrets } : { ...body.secrets };
  if (!samePlace && Object.keys(saved.secrets || {}).length && !(secrets.access_key_id && secrets.secret_access_key)) {
    return send(res, 400, JSON.stringify({ message: "Enter the access key again for a new address or bucket." }), "application/json");
  }
  const cfg = config({ values, secrets });
  if (!cfg) return send(res, 200, JSON.stringify({ valid: true }), "application/json"); // incomplete: saved, and the status asks for the rest
  const probe = await new Door({ settings: async () => cfg }).probe(cfg);
  if (probe.state === "ready") return send(res, 200, JSON.stringify({ valid: true }), "application/json");
  const message = probe.next === "settings"
    ? "The storage refused this key or bucket. Check the address, the bucket, the region and that the key may read and write it."
    : "The storage did not answer. Check the address and try again.";
  return send(res, 400, JSON.stringify({ message }), "application/json");
}

createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://storage").pathname;
    const repo = path.startsWith("/repo/");
    if (!allowed(req, repo)) return send(res, 401, "unauthorized");
    if (path === "/status" && req.method === "GET") return send(res, 200, JSON.stringify(await door.status()), "application/json");
    if (path === "/settings/check" && req.method === "POST") return await check(req, res);
    const m = /^\/repo\/([^/]+)\/([^/]+)(\/.*)$/.exec(path);
    if (!m) return send(res, 404, "not found");
    return await door.handle(req, res, m[1], m[2], m[3]);
  } catch {
    send(res, 502, "storage error");
  }
}).listen(Number(process.env.PICODE_EXT_PORT), "127.0.0.1");
