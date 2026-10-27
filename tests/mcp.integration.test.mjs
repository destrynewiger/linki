import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { Agent, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Database from "better-sqlite3";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nextBin = path.join(projectRoot, "node_modules", "next", "dist", "bin", "next");
const runtimeMode = process.env.LINKI_TEST_RUNTIME === "production" ? "start" : "dev";

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
     VALUES (?, ?, ?, 1, 25, 25, ?)`,
  ).run(fixtureIds.account, "Fixture Operator", "operator@example.invalid", "America/Los_Angeles");
  db.prepare("INSERT INTO workflows (id, name, description) VALUES (?, ?, ?)")
    .run(fixtureIds.workflow, "Fixture review queue", "Paused MCP staging workflow");
  db.prepare(
    `INSERT INTO workflow_steps
      (id, workflow_id, step_order, step_type, track, connect_note, enabled)
     VALUES (?, ?, 1, 'connect', 'linkedin', NULL, 1)`,
  ).run("integration-connect-step", fixtureIds.workflow);
  db.prepare("INSERT INTO lists (id, name, description, purpose) VALUES (?, ?, ?, 'linkedin')")
    .run(fixtureIds.list, "Fixture staged prospects", "MCP review list");
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
    fetch: async (input, init) => {
      try { return await fetch(input, init); }
      catch (error) {
        throw new Error(`MCP transport failure: ${error.cause?.code ?? error.message}\n${serverOutput.slice(-5000)}`, { cause: error });
      }
    },
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
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (nextProcess.exitCode !== null) {
      throw new Error(`Next.js exited before becoming ready.\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/hello`);
      await response.body?.cancel();
      if (response.status === 401) return;
    } catch {
      // The development server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for Next.js.\n${serverOutput}`);
}

async function startNext(overrides = {}) {
  const port = Number(new URL(baseUrl).port);
  nextProcess = spawn(process.execPath, [nextBin, runtimeMode, "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: projectRoot,
    env: {
      ...process.env,
      AUTH_PASSWORD: "integration-test-password",
      INTERNAL_API_SECRET: "integration-internal-test-secret",
      LINKI_DB_PATH: dbPath,
      LINKI_NEXT_DIST_DIR: nextDistDir ? path.basename(nextDistDir) : ".next",
      MCP_ACCOUNT_ID: fixtureIds.account,
      MCP_API_TOKEN: "integration-test-token",
      MCP_LIST_ID: fixtureIds.list,
      MCP_WORKFLOW_ID: fixtureIds.workflow,
      MCP_WRITES_ENABLED: "true",
      NEXTAUTH_SECRET: "integration-test-secret-with-enough-entropy",
      NEXTAUTH_URL: baseUrl,
      NEXT_TELEMETRY_DISABLED: "1",
      ...overrides,
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  nextProcess.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
  nextProcess.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });
  await waitForNextServer();
}

before(async () => {
  const port = await reservePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const testTempRoot = process.platform === "win32" ? tmpdir() : "/tmp";
  dataDir = await mkdtemp(path.join(testTempRoot, "linki-mcp-test-"));
  dbPath = path.join(dataDir, "linki.db");
  nextDistDir = runtimeMode === "dev" ? path.join(projectRoot, `.next-integration-${port}`) : undefined;
  await startNext();
  seedOutreachFixture();
});

async function stopNext() {
  if (nextProcess?.exitCode === null) {
    process.kill(-nextProcess.pid, "SIGKILL");
    await once(nextProcess, "exit");
  }
}

after(async () => {
  await stopNext();
  if (dataDir) await rm(dataDir, { force: true, recursive: true });
  if (nextDistDir) await rm(nextDistDir, { force: true, recursive: true });
});

test("the local UI responds without starting outreach", async () => {
  const response = await fetch(`${baseUrl}/login`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Linki/i);
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
      name: "Fixture Operator",
      email: "operator@example.invalid",
      is_authenticated: true,
      timezone: "America/Los_Angeles",
      daily_connection_limit: 25,
      connections_sent_today: 3,
      connections_remaining_today: 22,
      pending_connection_reservations: 0,
      staging_slots_remaining: 22,
      daily_message_limit: 25,
      messages_sent_today: 2,
      messages_remaining_today: 23,
    },
    workflow: {
      id: fixtureIds.workflow,
      name: "Fixture review queue",
      run_id: fixtureIds.run,
      run_status: "paused",
    },
    list: {
      id: fixtureIds.list,
      name: "Fixture staged prospects",
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
  normalizedDuplicate.prospects[0].linkedin_url = "https://linkedin.com/in/jane-doe/?tracking=removed";
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

function prospect(suffix) {
  return {
    account_key: `fixture-${suffix}.invalid`, signal_key: `signal-${suffix}`, signal_source: "sumble",
    signal_url: `https://example.invalid/signal/${suffix}`, signal_summary: "Synthetic review evidence",
    linkedin_url: `https://www.linkedin.com/in/fixture-${suffix}`,
    first_name: "Fixture", last_name: suffix, title: "Engineer", company: "Synthetic Company",
  };
}

function snapshotDb(db) {
  return ["targets", "list_targets", "mcp_signal_events", "run_profiles", "run_profile_tracks"]
    .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

async function withClient(t) {
  const { client, transport } = createAuthenticatedClient();
  t.after(async () => client.close());
  await client.connect(transport);
  return client;
}

async function stage(client, prospects) {
  return client.callTool({ name: "stage_prospects", arguments: { confirm_staging: true, prospects } });
}

test("MCP bearer and Origin checks are independent; UI auth cannot bypass MCP", async () => {
  for (const headers of [
    { authorization: "Bearer incorrect" },
    { authorization: "Basic integration-test-token" },
    { "x-internal-secret": "integration-internal-test-secret" },
  ]) {
    const response = await fetch(`${baseUrl}/api/mcp`, { method: "POST", headers });
    assert.equal(response.status, 401);
    await response.body?.cancel();
  }
  for (const origin of ["https://evil.invalid", "null", `${baseUrl}/path`, `${baseUrl}.evil.invalid`]) {
    const response = await fetch(`${baseUrl}/api/mcp`, {
      method: "POST", headers: { authorization: "Bearer integration-test-token", origin },
    });
    assert.equal(response.status, 403);
    await response.body?.cancel();
  }
  const client = new Client({ name: "origin-positive", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/api/mcp`), {
      requestInit: { headers: { authorization: "Bearer integration-test-token", origin: baseUrl } },
    }));
    assert.equal((await client.listTools()).tools.length, 2);
  } finally { await client.close(); }
  const protectedResponse = await fetch(`${baseUrl}/api/mcp-extra`);
  assert.equal(protectedResponse.status, 401);
  await protectedResponse.body?.cancel();
});

test("parsed-body requests preserve the same keep-alive socket after 500 ms", async t => {
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  async function call(id) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: {} });
      let socket;
      const req = httpRequest(`${baseUrl}/api/mcp`, { agent, method: "POST", headers: {
        authorization: "Bearer integration-test-token", accept: "application/json, text/event-stream",
        "content-type": "application/json", "content-length": Buffer.byteLength(body),
      } }, res => {
        let data = "";
        res.on("data", chunk => { data += chunk; });
        res.on("error", reject);
        res.on("end", () => resolve({ socket, reused: req.reusedSocket, status: res.statusCode, data }));
      });
      req.on("socket", value => { socket = value; });
      req.on("error", reject);
      req.end(body);
    });
  }
  const first = await call(1);
  assert.equal(first.status, 200);
  assert.equal(JSON.parse(first.data).result.tools.length, 2);
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.equal(first.socket.destroyed, false, "Response cleanup destroyed a reusable HTTP socket");
  const second = await call(2);
  assert.equal(second.status, 200);
  assert.equal(second.reused, true);
  assert.equal(second.socket, first.socket);
});

test("invalid profile URLs, whitespace keys and evidence URLs fail without mutations", async t => {
  const client = await withClient(t);
  const db = new Database(dbPath);
  t.after(() => db.close());
  const before = snapshotDb(db);
  for (const linkedin_url of ["http://www.linkedin.com/in/fixture", "https://evil.invalid/in/fixture",
    "https://www.linkedin.com@evil.invalid/in/fixture", "https://www.linkedin.com/company/fixture",
    "https://www.linkedin.com:8443/in/fixture", "https://www.linkedin.com/in/a/b", "file:///in/fixture"]) {
    assert.equal((await stage(client, [{ ...prospect("invalid"), linkedin_url }])).isError, true);
  }
  for (const field of ["account_key", "signal_key", "signal_source", "first_name", "signal_summary"]) {
    assert.equal((await stage(client, [{ ...prospect("invalid"), [field]: "   " }])).isError, true);
  }
  for (const signal_url of ["javascript:alert(1)", "file:///tmp/private", "https://user:secret@example.invalid/"]) {
    assert.equal((await stage(client, [{ ...prospect("invalid"), signal_url }])).isError, true);
  }
  assert.deepEqual(snapshotDb(db), before);
});

test("unsafe, revoked, nonpaused and ambiguous configurations refuse staging atomically", async t => {
  const client = await withClient(t);
  const db = new Database(dbPath);
  t.after(() => db.close());
  const before = snapshotDb(db);
  const changes = [
    ["UPDATE accounts SET daily_connection_limit = 100", "UPDATE accounts SET daily_connection_limit = 25"],
    ["UPDATE accounts SET daily_connection_limit = 0", "UPDATE accounts SET daily_connection_limit = 25"],
    ["UPDATE accounts SET is_authenticated = 0", "UPDATE accounts SET is_authenticated = 1"],
    ["UPDATE runs SET status = 'completed'", "UPDATE runs SET status = 'paused'"],
    ["UPDATE lists SET purpose = 'email'", "UPDATE lists SET purpose = 'linkedin'"],
    ["UPDATE workflow_steps SET connect_note = 'Hello'", "UPDATE workflow_steps SET connect_note = NULL"],
    ["UPDATE workflow_steps SET enabled = 0", "UPDATE workflow_steps SET enabled = 1"],
    ["UPDATE workflow_steps SET track = 'email'", "UPDATE workflow_steps SET track = 'linkedin'"],
    ["INSERT INTO workflow_steps (id,workflow_id,step_order,step_type,track,enabled) VALUES ('extra-step','integration-workflow',2,'message','linkedin',1)", "DELETE FROM workflow_steps WHERE id = 'extra-step'"],
    ["INSERT INTO runs (id,workflow_id,list_id,account_id,status) VALUES ('ambiguous-run','integration-workflow','integration-list','integration-account','paused')", "DELETE FROM runs WHERE id = 'ambiguous-run'"],
  ];
  for (const [change, restore] of changes) {
    db.exec(change);
    try {
      const status = await client.callTool({ name: "get_outreach_status", arguments: {} });
      assert.equal(status.structuredContent.configuration_valid, false, change);
      assert.equal((await stage(client, [prospect("unsafe")])).isError, true, change);
    } finally { db.exec(restore); }
    assert.deepEqual(snapshotDb(db), before);
  }
});

test("signal identity conflicts reject the entire batch and URL variants reuse existing targets", async t => {
  const client = await withClient(t);
  const db = new Database(dbPath);
  t.after(() => db.close());
  const first = prospect("conflict");
  assert.equal((await stage(client, [first])).structuredContent.enrolled, 1);
  const before = snapshotDb(db);
  assert.equal((await stage(client, [prospect("rollback-first"), { ...first, linkedin_url: prospect("other").linkedin_url }])).isError, true);
  assert.deepEqual(snapshotDb(db), before);
  db.prepare("INSERT INTO targets (id,linkedin_url) VALUES (?,?)")
    .run("legacy-variant", "https://linkedin.com/in/fixture-legacy/?source=old");
  const variant = await stage(client, [prospect("legacy")]);
  assert.equal(variant.structuredContent.created_targets, 0);
  assert.equal(variant.structuredContent.enrolled, 1);
  db.prepare("INSERT INTO targets (id,linkedin_url) VALUES (?,?)")
    .run("legacy-duplicate", "https://www.linkedin.com/in/fixture-legacy");
  const beforeAmbiguity = snapshotDb(db);
  assert.equal((await stage(client, [{ ...prospect("legacy"), signal_key: "new-ambiguous" }])).isError, true);
  assert.deepEqual(snapshotDb(db), beforeAmbiguity);
});

test("a pending enrollment elsewhere records evidence but creates no second track", async t => {
  const client = await withClient(t);
  const db = new Database(dbPath);
  t.after(() => db.close());
  db.prepare("INSERT INTO workflows (id,name) VALUES ('other-workflow','Other fixture queue')").run();
  db.prepare("INSERT INTO runs (id,workflow_id,list_id,account_id,status) VALUES ('other-run','other-workflow',?,?,'pending')")
    .run(fixtureIds.list, fixtureIds.account);
  db.prepare("INSERT INTO targets (id,linkedin_url) VALUES ('elsewhere-target',?)").run(prospect("elsewhere").linkedin_url);
  db.prepare("INSERT INTO run_profiles (id,run_id,target_id) VALUES ('elsewhere-profile','other-run','elsewhere-target')").run();
  db.prepare("INSERT INTO run_profile_tracks (id,run_profile_id,track,state) VALUES ('elsewhere-track','elsewhere-profile','linkedin','pending')").run();
  const result = await stage(client, [prospect("elsewhere")]);
  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent.enrolled, 0);
  assert.equal(result.structuredContent.skipped_active_elsewhere, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM run_profiles WHERE target_id='elsewhere-target'").get().n, 1);
});

test("concurrent retries create one signal and one paused enrollment", async t => {
  const client = await withClient(t);
  const second = await withClient(t);
  const item = prospect("concurrent");
  const results = await Promise.all([stage(client, [item]), stage(second, [item])]);
  assert(results.every(result => result.isError !== true));
  assert.equal(results.reduce((n, result) => n + result.structuredContent.enrolled, 0), 1);
  assert.equal(results.reduce((n, result) => n + result.structuredContent.duplicate_signals, 0), 1);
});

test("pending reservations bound repeated batches; exhausted retries remain no-ops", async t => {
  const client = await withClient(t);
  const db = new Database(dbPath);
  t.after(() => db.close());
  const status = (await client.callTool({ name: "get_outreach_status", arguments: {} })).structuredContent;
  const remaining = status.account.staging_slots_remaining;
  assert(remaining > 0);
  const batch = Array.from({ length: remaining }, (_, i) => prospect(`capacity-${i}`));
  const beforeOverflow = snapshotDb(db);
  assert.equal((await stage(client, [...batch, prospect("batch-overflow")])).isError, true);
  assert.deepEqual(snapshotDb(db), beforeOverflow);
  assert.equal((await stage(client, batch)).structuredContent.enrolled, remaining);
  const after = snapshotDb(db);
  assert.equal((await stage(client, [prospect("capacity-overflow")])).isError, true);
  assert.deepEqual(snapshotDb(db), after);
  // Daily sends also exhausted: a replay still has no incremental reservation cost.
  for (let i = 0; i < 22; i += 1) {
    db.prepare("INSERT INTO logs (id,run_id,level,message) VALUES (?,?,'info','Connection request sent to fixture')")
      .run(`exhaust-capacity-${i}`, fixtureIds.run);
  }
  const retry = await stage(client, batch);
  assert.notEqual(retry.isError, true);
  assert.equal(retry.structuredContent.enrolled, 0);
  assert.equal(retry.structuredContent.duplicate_signals, remaining);
  assert.deepEqual(snapshotDb(db), after);
  assert.equal(db.prepare("SELECT status FROM runs WHERE id = ?").get(fixtureIds.run).status, "paused");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status = 'running'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM run_profile_tracks WHERE state != 'pending'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM run_profiles WHERE email_account_id IS NOT NULL").get().n, 0);
});

test("staging requires explicit acknowledgement and rejects oversized input", async t => {
  const client = await withClient(t);
  const db = new Database(dbPath);
  t.after(() => db.close());
  const before = snapshotDb(db);
  for (const args of [{ prospects: [prospect("no-confirm")] },
    { confirm_staging: false, prospects: [prospect("no-confirm")] },
    { confirm_staging: true, prospects: Array.from({ length: 26 }, (_, i) => prospect(`large-${i}`)) }]) {
    assert.equal((await client.callTool({ name: "stage_prospects", arguments: args })).isError, true);
  }
  assert.deepEqual(snapshotDb(db), before);
});

test("disabled writes and absent MCP configuration fail closed after restart", async () => {
  await stopNext();
  await startNext({ MCP_WRITES_ENABLED: "false" });
  const { client, transport } = createAuthenticatedClient();
  const db = new Database(dbPath);
  try {
    const before = snapshotDb(db);
    await client.connect(transport);
    const status = (await client.callTool({ name: "get_outreach_status", arguments: {} })).structuredContent;
    assert.equal(status.writes_enabled, false);
    assert.equal(status.ready_to_stage, false);
    const disabled = await stage(client, [prospect("disabled")]);
    assert.equal(disabled.isError, true);
    assert.match(disabled.content[0].text, /Staging is disabled/);
    assert.deepEqual(snapshotDb(db), before);
  } finally { await client.close(); db.close(); }
  await stopNext();
  await startNext({ MCP_API_TOKEN: "" });
  const response = await fetch(`${baseUrl}/api/mcp`, {
    method: "POST", headers: { authorization: "Bearer integration-test-token" },
  });
  assert.equal(response.status, 503);
  await response.body?.cancel();
});
