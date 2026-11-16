// Fully isolated image smoke test: PostgreSQL and upstream credentials are synthetic.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const suffix = `mn-smoke-${process.pid}`,
  network = suffix,
  pg = `${suffix}-db`,
  app = `${suffix}-app`;
const image = process.env.SMOKE_IMAGE || "member-network:ci";
const scratch = mkdtempSync(join(tmpdir(), "mn-image-smoke-"));
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  docker("network", "create", network);
  docker(
    "run",
    "-d",
    "--name",
    pg,
    "--network",
    network,
    "--network-alias",
    "database",
    "-e",
    "POSTGRES_PASSWORD=isolated-smoke-only",
    "-e",
    "POSTGRES_DB=member_network_smoke",
    "postgres:17-alpine",
  );
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      docker("exec", pg, "pg_isready", "-h", "127.0.0.1", "-U", "postgres");
      ready = true;
      break;
    } catch {
      await wait(300);
    }
  }
  if (!ready) throw new Error("Test database did not become ready");
  docker(
    "exec",
    pg,
    "psql",
    "-U",
    "postgres",
    "-d",
    "member_network_smoke",
    "-c",
    "CREATE ROLE mn_smoke_app LOGIN PASSWORD 'isolated-smoke-runtime-only'",
  );
  const migration =
    "postgres://postgres:isolated-smoke-only@database:5432/member_network_smoke";
  const runtime =
    "postgres://mn_smoke_app:isolated-smoke-runtime-only@database:5432/member_network_smoke";
  docker(
    "run",
    "--rm",
    "--network",
    network,
    "-e",
    `MIGRATION_DATABASE_URL=${migration}`,
    image,
    "node",
    "scripts/migrate.js",
  );
  docker(
    "run",
    "--rm",
    "--network",
    network,
    "-e",
    `MIGRATION_DATABASE_URL=${migration}`,
    "-e",
    "RUNTIME_DATABASE_ROLE=mn_smoke_app",
    image,
    "node",
    "scripts/provision-runtime.js",
  );
  const shim = join(scratch, "upstream.mjs");
  writeFileSync(
    shim,
    `const original=globalThis.fetch;globalThis.fetch=async(url,options)=>{const u=String(url);if(u==='https://discord.com/api/v10/oauth2/applications/@me')return new Response(JSON.stringify({id:'123456789012345678'}));if(u==='https://identity.invalid/auth/v1/settings')return new Response('{}');return original(url,options);};`,
  );
  chmodSync(shim, 0o644);
  const env = join(scratch, "environment");
  writeFileSync(
    env,
    Object.entries({
      NODE_ENV: "production",
      SERVER_PORT: "9221",
      APP_BASE_URL: "https://network.example.test",
      DATABASE_URL: runtime,
      SUPABASE_URL: "https://identity.invalid",
      SUPABASE_PUBLISHABLE_KEY: "synthetic-smoke-key",
      DISCORD_APPLICATION_ID: "123456789012345678",
      DISCORD_CLIENT_ID: "123456789012345678",
      DISCORD_CLIENT_SECRET: "synthetic-smoke-secret",
      DISCORD_BOT_TOKEN: "synthetic-smoke-bot",
      DISCORD_REDIRECT_URI:
        "https://network.example.test/auth/discord/callback",
      TOKEN_ENCRYPTION_KEY: "a".repeat(64),
      ADMIN_USER_IDS: "10000000-0000-4000-8000-000000000001",
      AUTO_JOIN_ENABLED: "false",
      NODE_OPTIONS: "--import=/app/smoke-upstream.mjs",
    })
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
  const common = [
    "--network",
    network,
    "--env-file",
    env,
    "--mount",
    `type=bind,src=${shim},dst=/app/smoke-upstream.mjs,readonly`,
  ];
  const preflight = docker(
    "run",
    "--rm",
    ...common,
    image,
    "node",
    "scripts/preflight.js",
  );
  if (preflight.includes("FAIL")) throw new Error("Image preflight failed");
  docker("run", "-d", "--name", app, ...common, image);
  ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      docker(
        "exec",
        app,
        "node",
        "-e",
        "fetch('http://127.0.0.1:9221/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
      );
      ready = true;
      break;
    } catch {
      await wait(300);
    }
  }
  if (!ready) throw new Error("Image did not become ready");
  assertCheck(
    docker(
      "exec",
      app,
      "node",
      "-e",
      "console.log(process.getuid())",
    ).trim() !== "0",
    "Image must be non-root",
  );
  docker(
    "exec",
    app,
    "node",
    "-e",
    "fetch('http://127.0.0.1:9221/').then(async r=>{if(!r.ok||!(await r.text()).includes('Member Network'))process.exit(1)})",
  );
  docker("stop", "--time", "15", app);
  assertCheck(
    docker("inspect", "--format", "{{.State.ExitCode}}", app).trim() === "0",
    "Graceful shutdown failed",
  );
  console.info(
    "Container smoke passed: non-root, migrations, restricted role, preflight, SERVER_PORT, HTTP readiness, public UI, graceful stop. Upstreams mocked.",
  );
} catch (error) {
  console.error(error.message || "Container smoke failed");
  process.exitCode = 1;
} finally {
  for (const name of [app, pg])
    try {
      docker("rm", "-f", "-v", name);
    } catch {}
  try {
    docker("network", "rm", network);
  } catch {}
  rmSync(scratch, { recursive: true, force: true });
}
function assertCheck(value, message) {
  if (!value) throw new Error(message);
}
