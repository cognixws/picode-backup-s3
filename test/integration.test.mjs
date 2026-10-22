// Runs the COGNIX[WS] conformance kit (test/conformance.mjs, copied from
// examples/extensions/backup-conformance) against this storage and a real
// S3 server, through a stand-in for the Host API:
//
//   S3_TEST_ENDPOINT=http://127.0.0.1:8333 S3_TEST_BUCKET=backups \
//   S3_TEST_KEY=... S3_TEST_SECRET=... [S3_TEST_REGION=us-east-1] node --test
//
// Without S3_TEST_ENDPOINT it is skipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { runConformance } from "./conformance.mjs";
import { storage } from "./helpers.mjs";

const env = process.env;
const skip = !env.S3_TEST_ENDPOINT && "set S3_TEST_ENDPOINT to run against a real S3 server";

const settings = (over = {}) => ({
  values: { endpoint: env.S3_TEST_ENDPOINT, bucket: env.S3_TEST_BUCKET, region: env.S3_TEST_REGION || "us-east-1", prefix: "conformance-" + randomBytes(4).toString("hex"), ...over.values },
  secrets: { access_key_id: env.S3_TEST_KEY, secret_access_key: env.S3_TEST_SECRET, ...over.secrets },
});

for (const appendOnly of [false, true]) {
  test(`the conformance kit passes${appendOnly ? " (never delete)" : ""}`, { skip, timeout: 300_000 }, async () => {
    const s = await storage(settings({ values: { never_delete: appendOnly } }));
    try {
      const st = await s.status();
      assert.equal(st.state, "ready", JSON.stringify(st));
      const c = st.connections[0];
      const { passed, failed } = await runConformance({ base: `${s.url}/repo/${c.id}/cognix-test-${randomBytes(3).toString("hex")}`, secret: s.secret, status: s.url + "/status", appendOnly, log: () => {} });
      assert.deepEqual(failed, [], `${passed} passed`);
      assert.equal(c.deleteAllowed, !appendOnly);
    } finally { s.stop(); }
  });
}

test("a refused key asks for the settings; a storage that does not answer asks to retry", { skip, timeout: 60_000 }, async () => {
  const refused = await storage(settings({ secrets: { secret_access_key: "wrong" } }));
  try { assert.deepEqual(await refused.status(), { state: "needs-attention", next: "settings", connections: [] }); } finally { refused.stop(); }
  // Nothing listens there: within the three seconds COGNIX[WS] waits, it
  // says retry.
  const silent = await storage(settings({ values: { endpoint: "http://127.0.0.1:9" } }));
  try {
    const t = Date.now();
    assert.deepEqual(await silent.status(), { state: "needs-attention", next: "retry", connections: [] });
    assert.ok(Date.now() - t < 3000, "the status took " + (Date.now() - t) + " ms");
  } finally { silent.stop(); }
  const missing = await storage({ values: {}, secrets: {} });
  try { assert.deepEqual(await missing.status(), { state: "needs-setup", next: "settings", connections: [] }); } finally { missing.stop(); }
});

test("the repositories already in the bucket are named", { skip, timeout: 120_000 }, async () => {
  const prefix = "named-" + randomBytes(4).toString("hex");
  const s = await storage(settings({ values: { prefix } }));
  try {
    const c = (await s.status()).connections[0];
    const auth = { Authorization: "Basic " + Buffer.from("picode:" + s.secret).toString("base64") };
    const body = randomBytes(10);
    for (const r of ["cognix-a", "cognix-b"]) {
      assert.equal((await fetch(`${s.url}/repo/${c.id}/${r}/config`, { method: "POST", headers: auth, body })).status, 200);
    }
    await new Promise((r) => setTimeout(r, 50));
    const again = await storage(settings({ values: { prefix } }));
    try { assert.deepEqual((await again.status()).connections[0].repositories.sort(), ["cognix-a", "cognix-b"]); } finally { again.stop(); }
  } finally { s.stop(); }
});
