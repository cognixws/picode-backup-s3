// AWS Signature Version 4 for S3, with node:crypto alone. Only what this
// storage sends is signed: host, x-amz-content-sha256 and x-amz-date.
import { createHash, createHmac } from "node:crypto";

export const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
export const UNSIGNED = "UNSIGNED-PAYLOAD";

const hmac = (key, text) => createHmac("sha256", key).update(text).digest();
const hex = (text) => createHash("sha256").update(text).digest("hex");

// RFC 3986 encoding as SigV4 asks: everything but unreserved characters.
export function encode(text, keepSlash = false) {
  return Array.from(Buffer.from(String(text), "utf8"))
    .map((b) => {
      const c = String.fromCharCode(b);
      if (/[A-Za-z0-9\-_.~]/.test(c) || (keepSlash && c === "/")) return c;
      return "%" + b.toString(16).toUpperCase().padStart(2, "0");
    })
    .join("");
}

export function amzDate(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// sign returns the headers to send: the three signed ones and Authorization.
// path is already encoded; query is a plain object.
export function sign({ method, host, path, query = {}, payloadHash, accessKeyId, secretAccessKey, region, now = new Date(), service = "s3" }) {
  const date = amzDate(now);
  const day = date.slice(0, 8);
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => encode(k) + "=" + encode(query[k]))
    .join("&");
  const headers = { host, "x-amz-content-sha256": payloadHash, "x-amz-date": date };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => n + ":" + String(headers[n]).trim() + "\n").join("");
  const signedHeaders = names.join(";");
  const request = [method, path, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", date, scope, hex(request)].join("\n");
  const key = hmac(hmac(hmac(hmac("AWS4" + secretAccessKey, day), region), service), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return {
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": date,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
