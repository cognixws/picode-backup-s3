import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_SHA256, sign } from "../lib/sigv4.mjs";
import { checkSettings, config, parseEndpoint, parsePrefix } from "../lib/settings.mjs";

// AWS's published examples for Signature Version 4 (Amazon S3 API
// Reference, "Examples: Signature Calculations in AWS Signature Version 4").
const aws = { host: "examplebucket.s3.amazonaws.com", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1", now: new Date("2013-05-24T00:00:00Z"), payloadHash: EMPTY_SHA256 };

test("signs AWS's lifecycle example", () => {
  const h = sign({ ...aws, method: "GET", path: "/", query: { lifecycle: "" } });
  assert.match(h.authorization, /Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543$/);
  assert.equal(h["x-amz-date"], "20130524T000000Z");
});

test("signs AWS's list objects example", () => {
  const h = sign({ ...aws, method: "GET", path: "/", query: { "max-keys": "2", prefix: "J" } });
  assert.match(h.authorization, /Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7$/);
});

const good = {
  values: { endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com", bucket: "my-backups", region: "auto" },
  secrets: { access_key_id: "id", secret_access_key: "secret" },
};

test("reads the settings into a place whose id follows the bucket", () => {
  const a = config(good);
  assert.equal(a.virtual, false);
  assert.equal(a.label, "my-backups · r2.cloudflarestorage.com");
  assert.match(a.connection, /^s3-[0-9a-f]{16}$/);
  const b = config({ ...good, values: { ...good.values, bucket: "other" } });
  assert.notEqual(a.connection, b.connection);
  const c = config({ ...good, values: { ...good.values, prefix: "/pc/copies/" } });
  assert.equal(c.prefix, "pc/copies");
  assert.notEqual(a.connection, c.connection);
  assert.equal(config({ ...good, values: { ...good.values, endpoint: "https://s3.eu-west-1.amazonaws.com" } }).virtual, true);
  assert.equal(config({ ...good, values: { ...good.values, never_delete: true } }).neverDelete, true);
});

test("refuses what is missing or out of shape", () => {
  for (const over of [
    { values: { ...good.values, endpoint: "" } },
    { values: { ...good.values, bucket: "No_Caps" } },
    { values: { ...good.values, bucket: "a..b" } },
    { values: { ...good.values, region: "Bad Region" } },
    { values: { ...good.values, prefix: "../up" } },
    { secrets: { ...good.secrets, secret_access_key: "" } },
  ]) assert.equal(config({ ...good, ...over }), null, JSON.stringify(over));
});

test("plain http only inside this computer or the home network", () => {
  for (const ok of ["https://s3.example.com", "http://127.0.0.1:9000", "http://localhost:9000", "http://192.168.1.20:9000", "http://10.0.0.5", "http://nas.local:9000", "http://[::1]:9000"]) assert.ok(parseEndpoint(ok), ok);
  for (const bad of ["http://s3.example.com", "ftp://x", "https://user:pw@s3.example.com", "https://s3.example.com/bucket", "https://s3.example.com/?x=1", "http://8.8.8.8", "not a url"]) assert.equal(parseEndpoint(bad), null, bad);
});

test("a folder is plain names", () => {
  assert.equal(parsePrefix(""), "");
  assert.equal(parsePrefix("a/b_c/d.e"), "a/b_c/d.e");
  for (const bad of ["a/../b", "a//b", "a b", "./x", "a/" + "b/".repeat(8)]) assert.equal(parsePrefix(bad), null, bad);
});

test("the settings check answers fixed sentences, never the input", () => {
  assert.doesNotThrow(() => checkSettings({ values: {} }));
  for (const values of [{ endpoint: "http://example.com" }, { bucket: "X" }, { prefix: "a/../b" }, { region: "US EAST" }]) {
    assert.throws(() => checkSettings({ values }), (e) => e.status === 400 && !e.message.includes(Object.values(values)[0]));
  }
});
