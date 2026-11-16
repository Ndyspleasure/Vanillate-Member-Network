import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { database } from "../src/db.js";
import { migrate } from "../src/migrations.js";
import { vault } from "../src/crypto.js";
import { service } from "../src/service.js";
import { worker } from "../src/worker.js";
import { maintenance } from "../src/maintenance.js";
import { config, queued, member, community } from "../test/helpers.js";
const url = process.env.TEST_DATABASE_URL;
if (
  !url ||
  new URL(url).pathname !== "/member_network_test" ||
  !["127.0.0.1", "localhost"].includes(new URL(url).hostname)
)
  throw new Error(
    "Use an isolated local PostgreSQL database named member_network_test",
  );
const db = database(url);
test.after(() => db.close());
async function reset() {
  await migrate(db);
  await db.query(
    "TRUNCATE member_network.members,member_network.communities,member_network.campaigns,member_network.audit,member_network.runtime,member_network.sessions,member_network.oauth_states CASCADE",
  );
  const crypt = vault(config.TOKEN_ENCRYPTION_KEY),
    calls = { joins: [] };
  const token = {
    access_token: "test-only-access",
    refresh_token: "test-only-refresh",
    expires_in: 3600,
    scope: "identify guilds.join",
  };
  const discord = {
    guild: async (id) => ({ id }),
    join: async (...args) => {
      calls.joins.push(args);
      return "added";
    },
    refresh: async () => token,
    revoke: async () => {},
  };
  const svc = service(db, crypt, discord, config);
  return {
    db,
    crypt,
    calls,
    token,
    discord,
    svc,
    work: worker(db, crypt, discord, config),
  };
}
test("native PostgreSQL migrations are idempotent and concurrent workers claim one job only", async () => {
  const f = await reset();
  await migrate(db);
  await queued(f);
  const other = worker(db, f.crypt, f.discord, config);
  await Promise.all([f.work.runOne(), other.runOne()]);
  assert.equal(f.calls.joins.length, 1);
  assert.equal(
    (await db.query("SELECT status FROM member_network.jobs")).rows[0].status,
    "added",
  );
});
test("native row lock serializes disconnect against an in-flight join", async () => {
  const f = await reset();
  const { m } = await queued(f);
  let release, entered;
  const enteredJoin = new Promise((r) => (entered = r));
  const barrier = new Promise((r) => (release = r));
  f.discord.join = async () => {
    entered();
    await barrier;
    return "added";
  };
  const execution = f.work.runOne();
  await enteredJoin;
  let revoked = false;
  const revocation = f.svc.revokeConnection(m.id, m.id).then(() => {
    revoked = true;
  });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(revoked, false);
  release();
  await Promise.all([execution, revocation]);
  assert.equal(
    (await db.query("SELECT connection_status FROM member_network.members"))
      .rows[0].connection_status,
    "revoked",
  );
  await f.work.runOne();
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM member_network.jobs"))
      .rows[0].n,
    1,
  );
});
test("runtime role can use private service tables but cannot modify schema, roles or unrelated data", async () => {
  await reset();
  await db.query(
    "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='mn_test_app') THEN CREATE ROLE mn_test_app LOGIN PASSWORD 'isolated-runtime-test-only'; END IF; END $$",
  );
  execFileSync(process.execPath, ["scripts/provision-runtime.js"], {
    env: {
      ...process.env,
      MIGRATION_DATABASE_URL: url,
      RUNTIME_DATABASE_ROLE: "mn_test_app",
    },
    stdio: "pipe",
  });
  await db.query(
    "CREATE TABLE IF NOT EXISTS public.mn_unrelated_test(value text)",
  );
  const runtimeUrl = new URL(url);
  runtimeUrl.username = "mn_test_app";
  runtimeUrl.password = "isolated-runtime-test-only";
  const runtime = database(runtimeUrl.href);
  try {
    await runtime.query("SELECT id FROM member_network.members LIMIT 1");
    await runtime.query(
      "INSERT INTO member_network.runtime(key,value) VALUES ('runtime-proof',now())",
    );
    await assert.rejects(
      runtime.query("SELECT * FROM public.mn_unrelated_test"),
      (e) => e.code === "42501",
    );
    await assert.rejects(
      runtime.query(
        "ALTER TABLE member_network.members ADD COLUMN forbidden text",
      ),
      (e) => e.code === "42501",
    );
    await assert.rejects(
      runtime.query(
        "UPDATE member_network.schema_versions SET checksum='forbidden'",
      ),
      (e) => e.code === "42501",
    );
  } finally {
    await runtime.close();
  }
});
test("retention honors revoke completion before erasing identity and expires old job data", async () => {
  const f = await reset();
  const { m } = await queued(f);
  await db.query(
    "UPDATE member_network.members SET delete_requested_at=now() WHERE id=$1",
    [m.id],
  );
  await f.svc.revokeConnection(m.id, m.id);
  await maintenance(db);
  assert(
    (await db.query("SELECT discord_id FROM member_network.members")).rows[0]
      .discord_id,
  );
  await f.work.revokeOne();
  const row = (await db.query("SELECT * FROM member_network.members")).rows[0];
  assert.equal(row.discord_id, null);
  assert(row.deleted_at);
  await db.query(
    "UPDATE member_network.jobs SET updated_at=now()-interval '91 days'",
  );
  await maintenance(db);
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM member_network.jobs"))
      .rows[0].n,
    0,
  );
});
test("key rotation re-encrypts legacy credentials atomically with the current key", async () => {
  const f = await reset();
  await member(f);
  const oldKey = config.TOKEN_ENCRYPTION_KEY,
    newKey = "b".repeat(64);
  execFileSync(process.execPath, ["scripts/rotate-key.js"], {
    env: {
      ...process.env,
      DATABASE_URL: url,
      TOKEN_ENCRYPTION_KEY: newKey,
      TOKEN_ENCRYPTION_PREVIOUS_KEYS: oldKey,
    },
    stdio: "pipe",
  });
  const row = (await db.query("SELECT * FROM member_network.connections"))
    .rows[0];
  assert.equal(
    vault(newKey).decrypt(row.encrypted_tokens, row.member_id).access_token,
    f.token.access_token,
  );
  assert.throws(() =>
    vault(oldKey).decrypt(row.encrypted_tokens, row.member_id),
  );
});
