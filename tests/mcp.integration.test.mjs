import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Database from "better-sqlite3";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nextBin = path.join(projectRoot, "node_modules", "next", "dist", "bin", "next");

let baseUrl;
let dataDir;
let dbPath;
let nextDistDir;
let nextProcess;
let serverOutput = "";

const fixtureIds = {
  account: "integration-account",
  workflow: "integration-workflow",
  list: "integration-list",
  run: "integration-run",
};

function seedOutreachFixture() {
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO accounts
      (id, name, email, is_authenticated, daily_connection_limit, daily_message_limit, timezone)
     VALUES (?, ?, ?, 1, 100, 100, ?)`,
  ).run(fixtureIds.account, "John Bacchi", "john@example.com", "America/Los_Angeles");
  db.prepare("INSERT INTO workflows (id, name, description) VALUES (?, ?, ?)")
    .run(fixtureIds.workflow, "John review queue", "Paused MCP staging workflow");
  db.prepare(
    `INSERT INTO workflow_steps
      (id, workflow_id, step_order, step_type, track, connect_note, enabled)
     VALUES (?, ?, 1, 'connect', 'linkedin', NULL, 1)`,
  ).run("integration-connect-step", fixtureIds.workflow);
  db.prepare("INSERT INTO lists (id, name, description, purpose) VALUES (?, ?, ?, 'linkedin')")
    .run(fixtureIds.list, "John staged prospects", "MCP review list");
  db.prepare(
    `INSERT INTO runs (id, workflow_id, list_id, account_id, status)
     VALUES (?, ?, ?, ?, 'paused')`,
  ).run(fixtureIds.run, fixtureIds.workflow, fixtureIds.list, fixtureIds.account);

  const insertLog = db.prepare(
    "INSERT INTO logs (id, run_id, level, message) VALUES (?, ?, 'info', ?)",
  );
  for (let index = 0; index < 3; index += 1) {
    insertLog.run(`connect-log-${index}`, fixtureIds.run, "Connection request sent to fixture");
  }
  for (let index = 0; index < 2; index += 1) {
    insertLog.run(`message-log-${index}`, fixtureIds.run, "Message sent to fixture");
  }
  db.close();
}

function createAuthenticatedClient() {
  const client = new Client({ name: "linki-integration-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/api/mcp`), {
    requestInit: {
      headers: { authorization: "Bearer integration-test-token" },
    },
  });
  return { client, transport };
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
  const testTempRoot = process.platform === "win32" ? tmpdir() : "/tmp";
  dataDir = await mkdtemp(path.join(testTempRoot, "linki-mcp-test-"));
  dbPath = path.join(dataDir, "linki.db");
  nextDistDir = path.join(projectRoot, `.next-integration-${port}`);
  nextProcess = spawn(process.execPath, [nextBin, "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: projectRoot,
    env: {
      ...process.env,
      AUTH_PASSWORD: "integration-test-password",
      LINKI_DB_PATH: dbPath,
      LINKI_NEXT_DIST_DIR: path.basename(nextDistDir),
      MCP_ACCOUNT_ID: fixtureIds.account,
      MCP_API_TOKEN: "integration-test-token",
      MCP_LIST_ID: fixtureIds.list,
      MCP_WORKFLOW_ID: fixtureIds.workflow,
      MCP_WRITES_ENABLED: "true",
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
  seedOutreachFixture();
});

after(async () => {
  if (nextProcess?.exitCode === null) {
    process.kill(-nextProcess.pid, "SIGKILL");
    await once(nextProcess, "exit");
  }
  if (dataDir) await rm(dataDir, { force: true, recursive: true });
  if (nextDistDir) await rm(nextDistDir, { force: true, recursive: true });
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

test("an authenticated MCP client discovers only the approved tools", async (t) => {
  const { client, transport } = createAuthenticatedClient();
  t.after(async () => client.close());

  await client.connect(transport);
  const result = await client.listTools();

  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), [
    "get_outreach_status",
    "stage_prospects",
  ]);

  const statusTool = result.tools.find((tool) => tool.name === "get_outreach_status");
  const stageTool = result.tools.find((tool) => tool.name === "stage_prospects");
  assert.equal(statusTool?.annotations?.readOnlyHint, true);
  assert.equal(stageTool?.annotations?.readOnlyHint, false);
  assert.equal(stageTool?.annotations?.destructiveHint, false);
});

test("get_outreach_status reports the configured paused review queue and daily capacity", async (t) => {
  const { client, transport } = createAuthenticatedClient();
  t.after(async () => client.close());

  await client.connect(transport);
  const result = await client.callTool({ name: "get_outreach_status", arguments: {} });

  assert.notEqual(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    account: {
      id: fixtureIds.account,
      name: "John Bacchi",
      email: "john@example.com",
      is_authenticated: true,
      timezone: "America/Los_Angeles",
      daily_connection_limit: 25,
      connections_sent_today: 3,
      connections_remaining_today: 22,
      daily_message_limit: 25,
      messages_sent_today: 2,
      messages_remaining_today: 23,
    },
    workflow: {
      id: fixtureIds.workflow,
      name: "John review queue",
      run_id: fixtureIds.run,
      run_status: "paused",
    },
    list: {
      id: fixtureIds.list,
      name: "John staged prospects",
      target_count: 0,
    },
    configuration_valid: true,
    ready_to_stage: true,
    writes_enabled: true,
  });
});

test("stage_prospects idempotently enrolls a new signal while keeping outreach paused", async (t) => {
  const { client, transport } = createAuthenticatedClient();
  t.after(async () => client.close());
  await client.connect(transport);

  const input = {
    confirm_staging: true,
    prospects: [{
      account_key: "example.com",
      signal_key: "sumble:integration-signal-1",
      signal_source: "sumble",
      signal_url: "https://example.com/signals/integration-signal-1",
      signal_summary: "The company is moving model evaluation data between cloud environments.",
      linkedin_url: "https://www.linkedin.com/in/jane-doe",
      first_name: "Jane",
      last_name: "Doe",
      title: "VP of Data",
      company: "Example Corp",
    }],
  };

  const first = await client.callTool({ name: "stage_prospects", arguments: input });
  assert.notEqual(first.isError, true);
  assert.deepEqual(first.structuredContent, {
    run_id: fixtureIds.run,
    run_status: "paused",
    received: 1,
    staged: 1,
    created_targets: 1,
    added_to_list: 1,
    enrolled: 1,
    duplicate_signals: 0,
    new_accounts: 1,
    skipped_already_enrolled: 0,
    skipped_active_elsewhere: 0,
    outreach_started: false,
  });

  const normalizedDuplicate = structuredClone(input);
  normalizedDuplicate.prospects[0].account_key = "EXAMPLE.COM";
  normalizedDuplicate.prospects[0].signal_source = "Sumble";
  const duplicate = await client.callTool({ name: "stage_prospects", arguments: normalizedDuplicate });
  assert.notEqual(duplicate.isError, true);
  assert.deepEqual(duplicate.structuredContent, {
    run_id: fixtureIds.run,
    run_status: "paused",
    received: 1,
    staged: 0,
    created_targets: 0,
    added_to_list: 0,
    enrolled: 0,
    duplicate_signals: 1,
    new_accounts: 0,
    skipped_already_enrolled: 0,
    skipped_active_elsewhere: 0,
    outreach_started: false,
  });

  const newSignal = structuredClone(input);
  newSignal.prospects[0].signal_key = "sumble:integration-signal-2";
  newSignal.prospects[0].signal_url = "https://example.com/signals/integration-signal-2";
  const secondSignal = await client.callTool({ name: "stage_prospects", arguments: newSignal });
  assert.notEqual(secondSignal.isError, true);
  assert.deepEqual(secondSignal.structuredContent, {
    run_id: fixtureIds.run,
    run_status: "paused",
    received: 1,
    staged: 1,
    created_targets: 0,
    added_to_list: 0,
    enrolled: 0,
    duplicate_signals: 0,
    new_accounts: 0,
    skipped_already_enrolled: 1,
    skipped_active_elsewhere: 0,
    outreach_started: false,
  });

  const status = await client.callTool({ name: "get_outreach_status", arguments: {} });
  assert.equal(status.structuredContent?.workflow?.run_status, "paused");
  assert.equal(status.structuredContent?.list?.target_count, 1);
});
