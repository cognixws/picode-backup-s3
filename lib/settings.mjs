// The storage's settings: where the bucket is and the key that reaches it.
// Messages are fixed strings: a candidate key is never echoed, logged or kept.
import { createHash } from "node:crypto";
import { isIP } from "node:net";

export class SettingsError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const PREFIX_SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;
const REGION = /^[a-z0-9-]{1,32}$/;

// Plain HTTP is accepted only inside this computer or the home network
// (a NAS); everything else uses HTTPS. The core encrypts every object either
// way, and the key never travels: requests are signed.
function privateHost(host) {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".home.arpa")) return true;
  if (isIP(h) === 4) {
    const [a, b] = h.split(".").map(Number);
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
  }
  if (isIP(h) === 6) return h === "::1" || /^f[cd]/.test(h) || h.startsWith("fe80:");
  return false;
}

export function parseEndpoint(value) {
  let url;
  try { url = new URL(String(value || "").trim()); } catch { return null; }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && privateHost(url.hostname)) return url;
  return null;
}

export function parsePrefix(value) {
  const text = String(value || "").trim().replace(/^\/+|\/+$/g, "");
  if (!text) return "";
  const parts = text.split("/");
  if (parts.length > 8 || parts.some((p) => !PREFIX_SEGMENT.test(p) || p === "." || p === "..")) return null;
  return parts.join("/");
}

// config reads the saved settings ({values, secrets} from the Host API) into
// what the storage uses, or null when something is missing or out of shape.
export function config(settings) {
  const v = settings?.values || {}, s = settings?.secrets || {};
  const endpoint = parseEndpoint(v.endpoint);
  const bucket = String(v.bucket || "").trim();
  const prefix = parsePrefix(v.prefix);
  const region = String(v.region || "auto").trim() || "auto";
  const accessKeyId = String(s.access_key_id || "").trim();
  const secretAccessKey = String(s.secret_access_key || "");
  if (!endpoint || !BUCKET.test(bucket) || bucket.includes("..") || prefix === null || !REGION.test(region) || !accessKeyId || !secretAccessKey) return null;
  // AWS's own hosts take the bucket in the host name; everything else
  // (R2, B2, Wasabi, MinIO, a NAS) is addressed by path.
  const virtual = /(^|\.)amazonaws\.com$/.test(endpoint.hostname) && !bucket.includes(".");
  return {
    endpoint, bucket, prefix, region, accessKeyId, secretAccessKey, virtual,
    neverDelete: v.never_delete === true || v.never_delete === "true",
    // The place's id changes with the bucket, so a destination never follows
    // a settings change into a different bucket.
    connection: "s3-" + createHash("sha256").update([endpoint.origin, bucket, prefix].join("\n")).digest("hex").slice(0, 16),
    label: label(endpoint, bucket, prefix),
  };
}

function label(endpoint, bucket, prefix) {
  const host = endpoint.hostname.replace(/^[a-f0-9]{32}\./, ""); // R2's account id says nothing to a person
  const text = `${bucket}${prefix ? "/" + prefix : ""} · ${host}`;
  return [...text].length <= 80 ? text : [...text].slice(0, 79).join("") + "…";
}

// checkSettings checks the shape of what the person is about to save; the
// values that did not change are absent.
export function checkSettings(body) {
  const v = body?.values || {};
  if (v.endpoint !== undefined && v.endpoint !== "" && !parseEndpoint(v.endpoint)) throw new SettingsError("Write the address as https://host, like https://<account>.r2.cloudflarestorage.com. Plain http is for this computer or your home network only.");
  if (v.bucket !== undefined && v.bucket !== "" && (!BUCKET.test(String(v.bucket).trim()) || String(v.bucket).includes(".."))) throw new SettingsError("A bucket name has 3 to 63 lowercase letters, digits, dots or hyphens.");
  if (v.prefix !== undefined && parsePrefix(v.prefix) === null) throw new SettingsError("A folder is up to 8 names made of letters, digits, dots, underscores or hyphens, separated by /.");
  if (v.region !== undefined && v.region !== "" && !REGION.test(String(v.region).trim())) throw new SettingsError("A region is lowercase letters, digits and hyphens, like auto or us-east-1.");
}
