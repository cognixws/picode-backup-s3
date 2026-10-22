// Test helpers: a stand-in for the COGNIX[WS] Host API and this storage's
// process started the way COGNIX[WS] starts it.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const env = process.env;

function hostStandIn(settings) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url === "/api/ext/v1/settings" && req.headers["x-picode-extension-token"] === "token") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(settings));
      }
      res.writeHead(404).end();
    }).listen(0, "127.0.0.1", () => resolve(server));
  });
}

export async function storage(settings) {
  const host = await hostStandIn(settings);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const secret = randomBytes(16).toString("hex");
  const child = spawn(process.execPath, [new URL("../server.mjs", import.meta.url).pathname], {
    env: { ...env, PICODE_URL: `http://127.0.0.1:${host.address().port}`, PICODE_EXT_TOKEN: "token", PICODE_EXT_DATA: mkdtempSync(join(tmpdir(), "s3-")), PICODE_EXT_PORT: String(port), PICODE_EXT_PROXY_SECRET: secret },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try { await fetch(url + "/status"); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  const status = async () => (await fetch(url + "/status", { headers: { "X-PiCode-Proxy-Secret": secret } })).json();
  return { url, secret, status, stop: () => { child.kill(); host.close(); } };
}

