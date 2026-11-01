import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import {
  ensurePostgresDatabase,
  runDatabaseBackup,
  runDatabaseRestore,
} from "@paperclipai/db";
import {
  resolveDefaultSecretsKeyFilePath,
  resolveDefaultStorageDir,
} from "@paperclipai/shared/home-paths";

const requireFromDb = createRequire("/app/packages/db/package.json");
const postgres = requireFromDb("postgres");
const apiBase = "http://127.0.0.1:3100/api";
const syntheticApiKey = "synthetic-ci-hermes-gateway-key";
const syntheticOutput = "CI_SYNTHETIC_HERMES_HEARTBEAT_COMPLETED";
let agentApiToken = null;
const terminalStatuses = new Set(["succeeded", "failed", "timed_out", "cancelled", "interrupted"]);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(command + " failed (" + (result.status ?? "signal") + "): " + (result.stderr || "").slice(0, 1200));
  }
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function apiRequest(route, method = "GET", body, bearerToken) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (bearerToken) headers.authorization = "Bearer " + bearerToken;
  const response = await fetch(apiBase + route, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const raw = await response.text();
  let payload = null;
  try { payload = raw ? JSON.parse(raw) : null; } catch { /* report status only */ }
  if (!response.ok) {
    let message = typeof payload?.error === "string" ? payload.error : "";
    for (const secret of [syntheticApiKey, agentApiToken].filter(Boolean)) message = message.replaceAll(secret, "[redacted]");
    message = message.slice(0, 300);
    throw new Error(method + " " + route + " returned HTTP " + response.status + (message ? ": " + message : ""));
  }
  return payload;
}

function sendJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

let gatewayRunRequests = 0;
let gatewayEventRequests = 0;
let gatewayUnauthorizedRequests = 0;
let gatewayInputLength = 0;

const gateway = http.createServer(async (req, res) => {
  try {
    if (req.headers.authorization !== "Bearer " + syntheticApiKey) {
      gatewayUnauthorizedRequests += 1;
      sendJson(res, 401, { error: "synthetic authentication failed" });
      return;
    }
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (req.method === "GET" && pathname === "/health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }
    if (req.method === "POST" && pathname === "/v1/runs") {
      const body = JSON.parse(await readRequestBody(req));
      assert.equal(typeof body.input, "string");
      assert.ok(body.input.length > 0, "heartbeat must send a non-empty prompt");
      gatewayInputLength = body.input.length;
      gatewayRunRequests += 1;
      sendJson(res, 200, { run_id: "ci-hermes-heartbeat-run", status: "started" });
      return;
    }
    if (req.method === "GET" && pathname === "/v1/runs/ci-hermes-heartbeat-run/events") {
      gatewayEventRequests += 1;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const eventData = JSON.stringify({
        status: "completed",
        output: syntheticOutput,
        session_id: "ci-synthetic-session",
        usage: { input_tokens: 1, output_tokens: 1 },
        model: "synthetic-ci",
      });
      res.end(["event: run.completed", "data: " + eventData, "", ""].join("\n"));
      return;
    }
    if (req.method === "GET" && pathname === "/v1/runs/ci-hermes-heartbeat-run") {
      sendJson(res, 200, { run_id: "ci-hermes-heartbeat-run", status: "completed", output: syntheticOutput });
      return;
    }
    if (req.method === "POST" && pathname === "/v1/runs/ci-hermes-heartbeat-run/stop") {
      sendJson(res, 200, { status: "stopped" });
      return;
    }
    sendJson(res, 404, { error: "synthetic endpoint not found" });
  } catch {
    sendJson(res, 500, { error: "synthetic gateway fixture failed" });
  }
});

let restoreDatabaseName = null;
let restoreSql = null;
let adminSql = null;
let sourceSql = null;
let recoveryRoot = null;

try {
  if (process.env.DATABASE_URL) {
    throw new Error("isolated recovery smoke refuses an externally configured DATABASE_URL");
  }
  const configPath = process.env.PAPERCLIP_CONFIG ?? "/paperclip/instances/default/config.json";
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  if (config.database?.mode === "postgres") {
    throw new Error("isolated recovery smoke requires the disposable embedded PostgreSQL database");
  }
  const embeddedPort = Number(config.database?.embeddedPostgresPort) || 54329;
  const sourceConnectionString = "postgres://paperclip:paperclip@127.0.0.1:" + embeddedPort + "/paperclip";

  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const gatewayAddress = gateway.address();
  assert.ok(gatewayAddress && typeof gatewayAddress === "object");
  const gatewayBaseUrl = "http://127.0.0.1:" + gatewayAddress.port;

  const companyName = "Synthetic Hermes CI " + randomUUID().slice(0, 8);
  const company = await apiRequest("/companies", "POST", { name: companyName });
  assert.ok(company?.id, "Paperclip must create the synthetic CI company");

  const agent = await apiRequest("/companies/" + company.id + "/agents", "POST", {
    name: "Hermes Gateway CI",
    role: "ceo",
    adapterType: "hermes_gateway",
    adapterConfig: {
      apiBaseUrl: gatewayBaseUrl,
      apiKey: syntheticApiKey,
      timeoutSec: 20,
      eventReconnectMs: 250,
      pollIntervalMs: 250,
      sessionKeyStrategy: "run",
    },
  });
  assert.ok(agent?.id, "Paperclip must create the synthetic Hermes Gateway agent");
  assert.equal(agent.adapterType, "hermes_gateway");
  assert.ok(!JSON.stringify(agent).includes(syntheticApiKey), "agent API response must redact the synthetic key");

  const agentKey = await apiRequest("/agents/" + agent.id + "/keys", "POST", { name: "CI heartbeat qualification" });
  assert.ok(typeof agentKey?.token === "string" && agentKey.token.length > 20, "Paperclip must issue a one-time synthetic agent API token");
  agentApiToken = agentKey.token;
  const invoked = await apiRequest("/agents/" + agent.id + "/heartbeat/invoke", "POST", {
    reason: "Controlled synthetic Hermes Gateway heartbeat qualification",
    idempotencyKey: "ci-hermes-heartbeat-" + randomUUID(),
  }, agentApiToken);
  assert.ok(invoked?.id, "manual heartbeat invocation must create a run");

  const deadline = Date.now() + 60_000;
  let completedRun = null;
  while (Date.now() < deadline) {
    completedRun = await apiRequest("/heartbeat-runs/" + invoked.id);
    assert.ok(!JSON.stringify(completedRun).includes(syntheticApiKey), "heartbeat API must not expose the synthetic gateway key");
    assert.ok(!JSON.stringify(completedRun).includes(agentApiToken), "heartbeat API must not expose the synthetic agent token");
    if (terminalStatuses.has(completedRun.status)) break;
    await wait(250);
  }
  assert.equal(
    completedRun?.status,
    "succeeded",
    "controlled heartbeat did not succeed (status=" + (completedRun?.status ?? "missing") + ", code=" + (completedRun?.errorCode ?? "none") + ")",
  );
  assert.equal(gatewayRunRequests, 1, "Paperclip must dispatch exactly one Hermes Gateway run");
  assert.ok(gatewayEventRequests >= 1, "Paperclip must consume the Hermes Gateway SSE completion");
  assert.equal(gatewayUnauthorizedRequests, 0, "Paperclip must send the synthetic API key to the gateway");
  assert.ok(gatewayInputLength > 0);
  console.log("PASS: real Paperclip heartbeat route -> Hermes Gateway POST /v1/runs -> SSE completion; synthetic key redacted");

  const storageDir = resolveDefaultStorageDir();
  const secretsKeyPath = resolveDefaultSecretsKeyFilePath();
  await fs.mkdir(storageDir, { recursive: true });
  const storageProbeName = "ci-recovery-probe-" + randomUUID() + ".txt";
  const storageProbePath = path.join(storageDir, storageProbeName);
  const storageProbeContent = "synthetic Paperclip storage recovery probe " + randomUUID() + "\n";
  await fs.writeFile(storageProbePath, storageProbeContent, { mode: 0o600 });
  const keyStat = await fs.stat(secretsKeyPath);
  assert.ok(keyStat.isFile() && keyStat.size >= 16, "Paperclip local-encrypted master key must exist for the recovery rehearsal");

  sourceSql = postgres(sourceConnectionString, { max: 1 });
  const sourceCompany = await sourceSql.unsafe("SELECT id::text AS id, name FROM companies WHERE id = $1", [company.id]);
  const sourceAgent = await sourceSql.unsafe("SELECT id::text AS id, name, adapter_type FROM agents WHERE id = $1", [agent.id]);
  const sourceRun = await sourceSql.unsafe("SELECT id::text AS id, status FROM heartbeat_runs WHERE id = $1", [invoked.id]);
  const sourceSecrets = await sourceSql.unsafe("SELECT count(*)::int AS count FROM company_secrets WHERE company_id = $1", [company.id]);
  assert.equal(sourceCompany.length, 1);
  assert.equal(sourceAgent[0]?.adapter_type, "hermes_gateway");
  assert.equal(sourceRun[0]?.status, "succeeded");
  assert.ok(sourceSecrets[0]?.count >= 1, "synthetic Hermes API key must be represented by a Paperclip secret record");

  recoveryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ci-recovery-"));
  const bundleStage = path.join(recoveryRoot, "bundle-stage");
  const extracted = path.join(recoveryRoot, "restored-bundle");
  const restoredStorage = path.join(recoveryRoot, "restored-storage");
  const restoredSecrets = path.join(recoveryRoot, "restored-secrets");
  await Promise.all([bundleStage, extracted, restoredStorage, restoredSecrets].map((dir) => fs.mkdir(dir, { recursive: true })));

  const backupDir = path.join(recoveryRoot, "database-backups");
  await fs.mkdir(backupDir, { recursive: true });
  const backup = await runDatabaseBackup({
    connectionString: sourceConnectionString,
    backupDir,
    retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
    filenamePrefix: "paperclip-ci-recovery",
    backupEngine: "javascript",
  });
  assert.ok(backup.sizeBytes > 0);
  const databaseDumpName = "database.sql.gz";
  const storageArchiveName = "storage.tar.gz";
  await fs.copyFile(backup.backupFile, path.join(bundleStage, databaseDumpName));
  run("tar", ["-czf", path.join(bundleStage, storageArchiveName), "-C", storageDir, "."]);
  await fs.copyFile(secretsKeyPath, path.join(bundleStage, "master.key"));
  await fs.chmod(path.join(bundleStage, "master.key"), 0o600);

  const manifest = {
    format: "paperclip-ci-recovery-v1",
    sourceCompanyId: company.id,
    sourceAgentId: agent.id,
    sourceHeartbeatRunId: invoked.id,
    files: {
      [databaseDumpName]: sha256(await fs.readFile(path.join(bundleStage, databaseDumpName))),
      [storageArchiveName]: sha256(await fs.readFile(path.join(bundleStage, storageArchiveName))),
      "master.key": sha256(await fs.readFile(path.join(bundleStage, "master.key"))),
    },
  };
  await fs.writeFile(path.join(bundleStage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  const recoveryBundlePath = path.join(recoveryRoot, "paperclip-recovery-bundle.tar.gz");
  run("tar", ["-czf", recoveryBundlePath, "-C", bundleStage, "."]);
  run("tar", ["-xzf", recoveryBundlePath, "-C", extracted]);

  const restoredManifest = JSON.parse(await fs.readFile(path.join(extracted, "manifest.json"), "utf8"));
  for (const [name, expectedHash] of Object.entries(restoredManifest.files)) {
    assert.equal(sha256(await fs.readFile(path.join(extracted, name))), expectedHash, "recovery bundle checksum mismatch: " + name);
  }

  run("tar", ["-xzf", path.join(extracted, storageArchiveName), "-C", restoredStorage]);
  assert.equal(await fs.readFile(path.join(restoredStorage, storageProbeName), "utf8"), storageProbeContent);
  const restoredMasterKey = path.join(restoredSecrets, "master.key");
  await fs.copyFile(path.join(extracted, "master.key"), restoredMasterKey);
  await fs.chmod(restoredMasterKey, 0o600);
  assert.equal(sha256(await fs.readFile(restoredMasterKey)), restoredManifest.files["master.key"]);

  restoreDatabaseName = "paperclip_ci_restore_" + randomUUID().replaceAll("-", "").slice(0, 12);
  const adminUrl = new URL(sourceConnectionString);
  adminUrl.pathname = "/postgres";
  assert.equal(await ensurePostgresDatabase(adminUrl.toString(), restoreDatabaseName), "created");
  const restoreUrl = new URL(sourceConnectionString);
  restoreUrl.pathname = "/" + restoreDatabaseName;
  await runDatabaseRestore({
    connectionString: restoreUrl.toString(),
    backupFile: path.join(extracted, databaseDumpName),
  });

  restoreSql = postgres(restoreUrl.toString(), { max: 1 });
  const restoredCompany = await restoreSql.unsafe("SELECT id::text AS id, name FROM companies WHERE id = $1", [company.id]);
  const restoredAgent = await restoreSql.unsafe("SELECT id::text AS id, name, adapter_type FROM agents WHERE id = $1", [agent.id]);
  const restoredRun = await restoreSql.unsafe("SELECT id::text AS id, status FROM heartbeat_runs WHERE id = $1", [invoked.id]);
  const restoredSecrets = await restoreSql.unsafe("SELECT count(*)::int AS count FROM company_secrets WHERE company_id = $1", [company.id]);
  assert.equal(restoredCompany[0]?.name, companyName);
  assert.equal(restoredAgent[0]?.adapter_type, "hermes_gateway");
  assert.equal(restoredRun[0]?.status, "succeeded");
  assert.equal(restoredSecrets[0]?.count, sourceSecrets[0].count);
  console.log("PASS: database backup/restore preserves synthetic company, Hermes agent, heartbeat run and secret records");
  console.log("PASS: recovery bundle checksum, local storage file and encrypted-secrets master-key file restored into separate paths");
} finally {
  await restoreSql?.end().catch(() => undefined);
  await sourceSql?.end().catch(() => undefined);
  if (restoreDatabaseName) {
    const configPath = process.env.PAPERCLIP_CONFIG ?? "/paperclip/instances/default/config.json";
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    const embeddedPort = Number(config.database?.embeddedPostgresPort) || 54329;
    const adminUrl = "postgres://paperclip:paperclip@127.0.0.1:" + embeddedPort + "/postgres";
    adminSql = postgres(adminUrl, { max: 1 });
    await adminSql.unsafe('DROP DATABASE IF EXISTS "' + restoreDatabaseName + '"').catch(() => undefined);
    await adminSql.end().catch(() => undefined);
  }
  if (recoveryRoot) await fs.rm(recoveryRoot, { recursive: true, force: true }).catch(() => undefined);
  await new Promise((resolve) => {
    if (!gateway.listening) return resolve();
    gateway.close(() => resolve());
  });
}
