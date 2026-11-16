import test from "node:test";
import assert from "node:assert/strict";
import { discord, UpstreamError } from "../src/discord.js";
import { identity } from "../src/identity.js";
import { config } from "./helpers.js";
test("Discord adapter uses bot auth, guilds.join OAuth scope, and documented member response codes", async () => {
  const requests = [];
  const responses = [
    new Response(JSON.stringify({ pending: false }), { status: 201 }),
    new Response(null, { status: 204 }),
    new Response(JSON.stringify({ pending: true }), { status: 201 }),
    new Response(JSON.stringify({ retry_after: 12 }), { status: 429 }),
  ];
  const d = discord(config, async (url, options) => {
    requests.push({ url, options });
    return responses.shift();
  });
  const url = new URL(d.authorize("opaque-state"));
  assert.equal(url.searchParams.get("scope"), "identify guilds.join");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    config.DISCORD_REDIRECT_URI,
  );
  assert.equal(await d.join("guild", "user", "oauth-access"), "added");
  assert.equal(await d.join("guild", "user", "oauth-access"), "already_member");
  assert.equal(await d.join("guild", "user", "oauth-access"), "pending");
  await assert.rejects(
    d.join("guild", "user", "oauth-access"),
    (e) =>
      e instanceof UpstreamError && e.status === 429 && e.retryAfter === 12,
  );
  assert.equal(
    requests[0].options.headers.Authorization,
    `Bot ${config.DISCORD_BOT_TOKEN}`,
  );
  assert.equal(
    JSON.parse(requests[0].options.body).access_token,
    "oauth-access",
  );
  assert.equal(requests[0].options.method, "PUT");
});
test("Discord exchange/refresh validate payload; token material stays in POST body", async () => {
  let body;
  const d = discord(config, async (url, options) => {
    assert.equal(url, "https://discord.com/api/v10/oauth2/token");
    body = options.body;
    return new Response(
      JSON.stringify({
        access_token: "test-access",
        refresh_token: "test-refresh",
        expires_in: 3600,
        scope: "identify guilds.join",
      }),
    );
  });
  await d.exchange("test-code");
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("client_secret"), config.DISCORD_CLIENT_SECRET);
  await d.refresh("test-refresh");
  assert.equal(body.get("grant_type"), "refresh_token");
  const invalid = discord(config, async () => new Response("{}"));
  await assert.rejects(invalid.exchange("bad-code"));
});
test("Supabase identity validates access token at Auth user endpoint without trusting user metadata", async () => {
  const i = identity(config, async (url, options) => {
    assert.equal(url, `${config.SUPABASE_URL}/auth/v1/user`);
    assert.equal(options.headers.Authorization, "Bearer provided-token");
    return new Response(
      JSON.stringify({ id: "verified-user", user_metadata: { role: "owner" } }),
    );
  });
  assert.equal((await i.user("provided-token")).id, "verified-user");
});
