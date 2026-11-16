export class UpstreamError extends Error {
  constructor(status, code, retryAfter = 0) {
    super("External service request failed");
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}
export function discord(config, fetcher = fetch) {
  async function request(path, options = {}) {
    const response = await fetcher(`https://discord.com/api/v10${path}`, {
      ...options,
      signal: AbortSignal.timeout(12000),
    });
    const data =
      response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok)
      throw new UpstreamError(
        response.status,
        Number(data?.code) || 0,
        Math.min(86400, Math.max(1, Number(data?.retry_after) || 5)),
      );
    return { status: response.status, data };
  }
  async function token(params) {
    const { data } = await request("/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.DISCORD_CLIENT_ID,
        client_secret: config.DISCORD_CLIENT_SECRET,
        ...params,
      }),
    });
    if (
      !data.access_token ||
      !data.refresh_token ||
      !Number.isFinite(data.expires_in)
    )
      throw new UpstreamError(502, 0);
    return data;
  }
  const bot = { Authorization: `Bot ${config.DISCORD_BOT_TOKEN}` };
  return {
    authorize(state, scopes = "identify guilds.join") {
      return `https://discord.com/oauth2/authorize?${new URLSearchParams({ client_id: config.DISCORD_CLIENT_ID, redirect_uri: config.DISCORD_REDIRECT_URI, response_type: "code", scope: scopes, state, prompt: "consent" })}`;
    },
    exchange: (code) =>
      token({
        grant_type: "authorization_code",
        code,
        redirect_uri: config.DISCORD_REDIRECT_URI,
      }),
    refresh: (refresh_token) =>
      token({ grant_type: "refresh_token", refresh_token }),
    profile: async (access) =>
      (
        await request("/users/@me", {
          headers: { Authorization: `Bearer ${access}` },
        })
      ).data,
    async verifyBot() {
      const { data } = await request("/oauth2/applications/@me", {
        headers: bot,
      });
      if (data.id !== config.DISCORD_APPLICATION_ID)
        throw new Error("Bot application mismatch");
    },
    guild: async (id) =>
      (await request(`/guilds/${id}`, { headers: bot })).data,
    async join(guildId, userId, access) {
      const r = await request(`/guilds/${guildId}/members/${userId}`, {
        method: "PUT",
        headers: { ...bot, "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: access }),
      });
      return r.status === 204
        ? "already_member"
        : r.data?.pending
          ? "pending"
          : "added";
    },
    async revoke(access) {
      await request("/oauth2/token/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: config.DISCORD_CLIENT_ID,
          client_secret: config.DISCORD_CLIENT_SECRET,
          token: access,
        }),
      });
    },
  };
}
