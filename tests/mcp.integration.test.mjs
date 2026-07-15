import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nextBin = path.join(projectRoot, "node_modules", "next", "dist", "bin", "next");

let baseUrl;
let dataDir;
let nextProcess;
let serverOutput = "";

function absoluteTempDirectory() {
  const directory = tmpdir();
  return path.isAbsolute(directory) ? directory : path.resolve("/", directory);
}

async function reservePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const { port } = address;
  server.close();
  await once(server, "close");
  return port;
}

async function waitForNextServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (nextProcess.exitCode !== null) {
      throw new Error(`Next.js exited before becoming ready.\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/hello`);
      await response.body?.cancel();
      return;
    } catch {
      // The development server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for Next.js.\n${serverOutput}`);
}

before(async () => {
  const port = await reservePort();
  baseUrl = `http://127.0.0.1:${port}`;
  dataDir = await mkdtemp(path.join(absoluteTempDirectory(), "linki-mcp-test-"));
  nextProcess = spawn(process.execPath, [nextBin, "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: projectRoot,
    env: {
      ...process.env,
      AUTH_PASSWORD: "integration-test-password",
      LINKI_DB_PATH: path.join(dataDir, "linki.db"),
      LINKI_NEXT_DIST_DIR: path.join(dataDir, ".next"),
      MCP_API_TOKEN: "integration-test-token",
      NEXTAUTH_SECRET: "integration-test-secret-with-enough-entropy",
      NEXTAUTH_URL: baseUrl,
      NEXT_TELEMETRY_DISABLED: "1",
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  nextProcess.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
  nextProcess.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });
  await waitForNextServer();
});

after(async () => {
  if (nextProcess?.exitCode === null) {
    process.kill(-nextProcess.pid, "SIGKILL");
    await once(nextProcess, "exit");
  }
  if (dataDir) await rm(dataDir, { force: true, recursive: true });
});

test("the MCP endpoint rejects requests without a bearer token", async () => {
  const response = await fetch(`${baseUrl}/api/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "linki-integration-test", version: "1.0.0" },
      },
    }),
  });

  assert.equal(response.status, 401);
});
