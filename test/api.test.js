import test from "node:test";
import assert from "node:assert/strict";
import { fixture, member, community, headers, viewerId } from "./helpers.js";

test("API rejects forged identity, viewer mutations, CSRF, invalid IDs, and does not leak SQL", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.app.inject("/api/admin/members")).statusCode, 401);
    assert.equal(
      (
        await f.app.inject({
          url: "/api/admin/members",
          headers: headers("bad"),
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await f.app.inject({
          url: "/api/admin/members",
          headers: headers("outsider"),
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          url: "/api/admin/members",
          headers: headers("viewer"),
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          url: "/api/admin/analytics",
          headers: headers("viewer"),
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/admin/communities",
          headers: headers("viewer"),
          payload: {},
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/admin/campaigns",
          headers: { ...headers(), origin: "https://evil.invalid" },
          payload: {},
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/admin/campaigns",
          headers: { authorization: "Bearer admin" },
          payload: {},
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "PATCH",
          url: "/api/admin/members/not-a-uuid",
          headers: headers(),
          payload: { active: false },
        })
      ).statusCode,
      400,
    );
    const result = await f.app.inject({
      method: "POST",
      url: "/api/admin/communities",
      headers: headers(),
      payload: {
        guild_id: "345678901234567890",
        name: "Test Community",
        description: "Gaming",
        tags: ["gaming"],
      },
    });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().status, "pending");
    const duplicate = await f.app.inject({
      method: "POST",
      url: "/api/admin/communities",
      headers: headers(),
      payload: {
        guild_id: "345678901234567890",
        name: "Test Community",
        description: "Gaming",
      },
    });
    assert.equal(duplicate.statusCode, 409);
    assert(!duplicate.body.includes("INSERT"));
  } finally {
    await f.close();
  }
});
test("admin password login gives HttpOnly session; logout invalidates it", async () => {
  const f = await fixture();
  try {
    let r = await f.app.inject({
      method: "POST",
      url: "/auth/admin/login",
      headers: headers(),
      payload: { email: "admin@example.test", password: "wrong" },
    });
    assert.equal(r.statusCode, 401);
    r = await f.app.inject({
      method: "POST",
      url: "/auth/admin/login",
      headers: headers(),
      payload: { email: "admin@example.test", password: "correct" },
    });
    assert.equal(r.statusCode, 200);
    assert(r.headers["set-cookie"].includes("HttpOnly"));
    assert(!r.body.includes("access_token"));
    const cookie = r.headers["set-cookie"].split(";")[0];
    assert.equal(
      (await f.app.inject({ url: "/api/admin/session", headers: { cookie } }))
        .statusCode,
      200,
    );
    await f.app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { ...headers(), cookie },
      payload: {},
    });
    assert.equal(
      (await f.app.inject({ url: "/api/admin/session", headers: { cookie } }))
        .statusCode,
      401,
    );
  } finally {
    await f.close();
  }
});
test("member privacy, consent, catalog filters and status changes work end to end", async () => {
  const f = await fixture();
  try {
    const m = await member(f),
      c = await community(f);
    const raw = await f.svc.session("member", m.id);
    const h = { origin: "http://localhost:3000", cookie: `mn_member=${raw}` };
    assert.equal((await f.app.inject("/api/me")).statusCode, 401);
    let r = await f.app.inject({ url: "/api/me", headers: h });
    assert.equal(r.statusCode, 200);
    assert(!r.body.includes("access-test"));
    r = await f.app.inject("/api/catalog?tag=gaming&language=id");
    assert.equal(r.json().items.length, 1);
    assert(!r.body.includes("guild_id"));
    assert.equal(
      (await f.app.inject("/api/catalog?tag=music")).json().items.length,
      0,
    );
    r = await f.app.inject({
      method: "POST",
      url: `/api/me/consents/${c.id}`,
      headers: h,
      payload: {},
    });
    assert.equal(r.statusCode, 200);
    r = await f.app.inject({ url: "/api/me", headers: h });
    assert.equal(r.json().consents.length, 1);
    await f.app.inject({
      method: "DELETE",
      url: `/api/me/consents/${c.id}`,
      headers: h,
    });
    assert.equal(
      (await f.app.inject({ url: "/api/me", headers: h })).json().consents
        .length,
      0,
    );
    r = await f.app.inject({
      method: "PATCH",
      url: `/api/admin/members/${m.id}`,
      headers: headers(),
      payload: { active: false },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: `/api/me/consents/${c.id}`,
          headers: h,
          payload: {},
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await f.app.inject({
          url: "/api/admin/audit",
          headers: headers("viewer"),
        })
      ).statusCode,
      403,
    );
  } finally {
    await f.close();
  }
});
test("security headers, rate limiting and public pages are present", async () => {
  const f = await fixture();
  try {
    const r = await f.app.inject("/");
    assert.equal(r.statusCode, 200);
    assert(
      r.headers["content-security-policy"].includes("frame-ancestors 'none'"),
    );
    assert.equal(r.headers["referrer-policy"], "no-referrer");
    assert.equal((await f.app.inject("/admin")).statusCode, 200);
    for (let i = 0; i < 5; i++)
      await f.app.inject({
        method: "POST",
        url: "/auth/admin/login",
        headers: headers(),
        payload: { email: "a@example.test", password: "wrong" },
      });
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/auth/admin/login",
          headers: headers(),
          payload: { email: "a@example.test", password: "wrong" },
        })
      ).statusCode,
      429,
    );
  } finally {
    await f.close();
  }
});
test("completed campaign cannot be reopened via pause and start", async () => {
  const f = await fixture();
  try {
    const c = await community(f);
    const created = await f.app.inject({
      method: "POST",
      url: "/api/admin/campaigns",
      headers: headers(),
      payload: {
        community_id: c.id,
        name: "Closed campaign",
        starts_at: "2026-01-01T00:00:00Z",
        ends_at: "2099-12-31T00:00:00Z",
        limit: 10,
      },
    });
    assert.equal(created.statusCode, 200);
    const id = created.json().id;
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: `/api/admin/campaigns/${id}/complete`,
          headers: headers(),
          payload: {},
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: `/api/admin/campaigns/${id}/pause`,
          headers: headers(),
          payload: {},
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: `/api/admin/campaigns/${id}/start`,
          headers: headers(),
          payload: {},
        })
      ).statusCode,
      409,
    );
  } finally {
    await f.close();
  }
});
