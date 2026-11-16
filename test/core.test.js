import test from "node:test";
import assert from "node:assert/strict";
import { vault } from "../src/crypto.js";
import { loadConfig } from "../src/config.js";
import {
  fixture,
  member,
  community,
  campaign,
  queued,
  adminId,
  config,
} from "./helpers.js";

test("encrypted credentials are bound to member and reject tampering", () => {
  const v = vault("b".repeat(64)),
    cipher = v.encrypt({ access_token: "private-value" }, "member-a");
  assert(!cipher.includes("private-value"));
  assert.equal(v.decrypt(cipher, "member-a").access_token, "private-value");
  assert.throws(() => v.decrypt(cipher, "member-b"));
  assert.throws(() => v.decrypt(cipher.slice(0, -2) + "ab", "member-a"));
});
test("configuration fails closed for absent secret, application mismatch, insecure production and missing admin", () => {
  const env = {
    ...config,
    DATABASE_URL: "postgres://test",
    ADMIN_USER_IDS: adminId,
    VIEWER_USER_IDS: "",
    AUTO_JOIN_ENABLED: "false",
  };
  assert.equal(loadConfig(env).AUTO_JOIN_ENABLED, false);
  assert.equal(loadConfig({ ...env, CMS_ORIGIN: "" }).CMS_ORIGIN, undefined);
  for (const change of [
    { TOKEN_ENCRYPTION_KEY: "" },
    { DISCORD_CLIENT_ID: "999999999999999999" },
    { ADMIN_USER_IDS: "" },
    { NODE_ENV: "production" },
    { DISCORD_REDIRECT_URI: "https://elsewhere.test/callback" },
  ])
    assert.throws(() => loadConfig({ ...env, ...change }));
});
test("schema is additive, idempotent, RLS enabled, clients cannot access private tables", async () => {
  const f = await fixture();
  try {
    await f.engine.exec(f.sql);
    const r = await f.db.query(
      "SELECT relname,relrowsecurity FROM pg_class JOIN pg_namespace ON pg_namespace.oid=relnamespace WHERE nspname='member_network' AND relkind='r'",
    );
    assert.equal(r.rows.length, 10);
    assert(r.rows.every((x) => x.relrowsecurity));
    await f.engine.exec("SET ROLE anon");
    await assert.rejects(
      f.db.query("SELECT * FROM member_network.members"),
      /permission denied/,
    );
    await f.engine.exec("RESET ROLE; SET ROLE authenticated");
    await assert.rejects(
      f.db.query("SELECT * FROM member_network.connections"),
      /permission denied/,
    );
  } finally {
    await f.close();
  }
});
test("OAuth rejects wrong browser and replay, verifies required scopes, encrypts tokens", async () => {
  const f = await fixture();
  try {
    let url = await f.svc.beginOAuth("browser-original");
    let state = new URL(url).searchParams.get("state");
    await assert.rejects(f.svc.callback(state, "wrong-browser", "code"));
    assert.equal(f.calls.exchange, 0);
    const cookie = await f.svc.callback(state, "browser-original", "code");
    assert(await f.svc.getSession(cookie, "member"));
    await assert.rejects(f.svc.callback(state, "browser-original", "code"));
    assert.equal(f.calls.exchange, 1);
    const row = (
      await f.db.query(
        "SELECT encrypted_tokens FROM member_network.connections",
      )
    ).rows[0];
    assert(!row.encrypted_tokens.includes("access-test"));
    url = await f.svc.beginOAuth("browser-two");
    state = new URL(url).searchParams.get("state");
    f.token.scope = "identify";
    await assert.rejects(f.svc.callback(state, "browser-two", "code"), /Izin/);
  } finally {
    await f.close();
  }
});
test("expired OAuth state is rejected before token exchange", async () => {
  const f = await fixture();
  try {
    const state = new URL(await f.svc.beginOAuth("b")).searchParams.get(
      "state",
    );
    await f.db.query(
      "UPDATE member_network.oauth_states SET expires_at=now()-interval '1 second'",
    );
    await assert.rejects(f.svc.callback(state, "b", "code"));
    assert.equal(f.calls.exchange, 0);
  } finally {
    await f.close();
  }
});
test("no consent means no job; starting repeatedly does not duplicate jobs", async () => {
  const f = await fixture();
  try {
    const m = await member(f),
      c = await community(f),
      p = await campaign(f, c);
    assert.equal((await f.svc.startCampaign(p.id, adminId)).queued, 0);
    await f.svc.consent(m.id, c.id);
    assert.equal((await f.svc.startCampaign(p.id, adminId)).queued, 1);
    assert.equal((await f.svc.startCampaign(p.id, adminId)).queued, 0);
    await f.work.runOne();
    assert.equal(f.calls.joins.length, 1);
    assert.equal(
      (await f.db.query("SELECT status FROM member_network.jobs")).rows[0]
        .status,
      "added",
    );
    await f.work.runOne();
    assert.equal(f.calls.joins.length, 1);
  } finally {
    await f.close();
  }
});
test("revocation cancels job and renewed consent cannot resurrect an old job", async () => {
  const f = await fixture();
  try {
    const { m, c, p } = await queued(f);
    await f.svc.removeConsent(m.id, c.id);
    await f.svc.consent(m.id, c.id);
    await f.svc.startCampaign(p.id, adminId);
    await f.work.runOne();
    assert.equal(f.calls.joins.length, 0);
    assert.equal(
      (await f.db.query("SELECT status FROM member_network.jobs")).rows[0]
        .status,
      "cancelled",
    );
  } finally {
    await f.close();
  }
});
test("worker rechecks disabled member, campaign pause, and suspended community", async () => {
  for (const update of [
    "UPDATE member_network.members SET active=false",
    "UPDATE member_network.campaigns SET status='paused'",
    "UPDATE member_network.communities SET status='suspended'",
  ]) {
    const f = await fixture();
    try {
      await queued(f);
      await f.db.query(update);
      await f.work.runOne();
      assert.equal(f.calls.joins.length, 0);
    } finally {
      await f.close();
    }
  }
});
test("refresh occurs under connection lock and rotated tokens are persisted", async () => {
  const f = await fixture();
  try {
    await queued(f);
    await f.db.query(
      "UPDATE member_network.connections SET expires_at=now()-interval '1 minute'",
    );
    await f.work.runOne();
    assert.equal(f.calls.refresh, 1);
    assert.equal(f.calls.joins[0][2], "rotated-access");
    const c = (await f.db.query("SELECT * FROM member_network.connections"))
      .rows[0];
    assert.equal(
      f.crypt.decrypt(c.encrypted_tokens, c.member_id).access_token,
      "rotated-access",
    );
  } finally {
    await f.close();
  }
});
test("join results distinguish existing members and screening", async () => {
  for (const result of ["already_member", "pending"]) {
    const f = await fixture();
    try {
      await queued(f);
      f.discord.join = async () => result;
      await f.work.runOne();
      assert.equal(
        (await f.db.query("SELECT status FROM member_network.jobs")).rows[0]
          .status,
        result,
      );
    } finally {
      await f.close();
    }
  }
});
test("rate limit schedules bounded retry and persists global backoff", async () => {
  const f = await fixture();
  try {
    await queued(f);
    f.discord.join = async () => {
      throw Object.assign(new Error("rate limited"), {
        status: 429,
        retryAfter: 120,
      });
    };
    await f.work.runOne();
    const r = (
      await f.db.query("SELECT status,next_attempt_at FROM member_network.jobs")
    ).rows[0];
    assert.equal(r.status, "retry");
    await f.db.query(
      "UPDATE member_network.jobs SET attempts=4,next_attempt_at=now()",
    );
    await f.work.runOne();
    assert.equal(
      (await f.db.query("SELECT status FROM member_network.jobs")).rows[0]
        .status,
      "failed",
    );
    assert(
      new Date(
        (
          await f.db.query(
            "SELECT value FROM member_network.runtime WHERE key='discord_backoff'",
          )
        ).rows[0].value,
      ) > new Date(),
    );
    assert(new Date(r.next_attempt_at) > new Date());
    assert.equal(
      (await f.db.query("SELECT count(*) FROM member_network.runtime")).rows[0]
        .count,
      1,
    );
  } finally {
    await f.close();
  }
});
test("ambiguous request timeout and crash recovery never blindly repeat a join", async () => {
  const f = await fixture();
  try {
    await queued(f);
    f.discord.join = async () => {
      throw new Error("network timeout");
    };
    await f.work.runOne();
    assert.equal(
      (await f.db.query("SELECT status FROM member_network.jobs")).rows[0]
        .status,
      "unknown",
    );
    await f.db.query(
      "UPDATE member_network.jobs SET status='processing',lease_until=now()-interval '1 minute'",
    );
    await f.work.runOne();
    assert.equal(
      (await f.db.query("SELECT status,error_code FROM member_network.jobs"))
        .rows[0].error_code,
      "LEASE_EXPIRED",
    );
  } finally {
    await f.close();
  }
});
test("disconnect immediately blocks joins, removes sessions, revokes Discord and erases ciphertext", async () => {
  const f = await fixture();
  try {
    const { m } = await queued(f);
    const s = await f.svc.session("member", m.id);
    await f.svc.revokeConnection(m.id, m.id);
    assert.equal(await f.svc.getSession(s, "member"), undefined);
    await f.work.runOne();
    assert.equal(f.calls.joins.length, 0);
    await f.work.revokeOne();
    assert.equal(f.calls.revoke, 1);
    assert.equal(
      (
        await f.db.query(
          "SELECT encrypted_tokens FROM member_network.connections",
        )
      ).rows[0].encrypted_tokens,
      null,
    );
  } finally {
    await f.close();
  }
});
test("one consent cannot be reused by another campaign and repeated starts respect cap", async () => {
  const f = await fixture();
  try {
    const { m, c } = await queued(f);
    const second = await campaign(f, c);
    assert.equal((await f.svc.startCampaign(second.id, adminId)).queued, 0);
    await f.svc.removeConsent(m.id, c.id);
    await f.svc.consent(m.id, c.id);
    assert.equal((await f.svc.startCampaign(second.id, adminId)).queued, 1);
    assert.equal((await f.svc.startCampaign(second.id, adminId)).queued, 0);
  } finally {
    await f.close();
  }
});
test("failed upstream revocation retains encrypted retry material but never restores permission", async () => {
  const f = await fixture();
  try {
    const { m } = await queued(f);
    await f.svc.revokeConnection(m.id, m.id);
    f.discord.revoke = async () => {
      throw new Error("offline");
    };
    await f.work.revokeOne();
    const c = (await f.db.query("SELECT * FROM member_network.connections"))
      .rows[0];
    assert(c.revoke_pending);
    assert(c.encrypted_tokens);
    assert(new Date(c.revoke_after) > new Date());
    await f.work.runOne();
    assert.equal(f.calls.joins.length, 0);
  } finally {
    await f.close();
  }
});
