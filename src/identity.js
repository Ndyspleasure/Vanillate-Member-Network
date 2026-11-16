import { UpstreamError } from "./discord.js";
export function identity(config, fetcher = fetch) {
  const headers = {
    apikey: config.SUPABASE_PUBLISHABLE_KEY,
    "Content-Type": "application/json",
  };
  async function call(path, options = {}) {
    const r = await fetcher(`${config.SUPABASE_URL}/auth/v1${path}`, {
      ...options,
      headers: { ...headers, ...options.headers },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new UpstreamError(r.status, 0);
    return r.json();
  }
  return {
    login: (email, password) =>
      call("/token?grant_type=password", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      }),
    user: (token) =>
      call("/user", { headers: { Authorization: `Bearer ${token}` } }),
  };
}
