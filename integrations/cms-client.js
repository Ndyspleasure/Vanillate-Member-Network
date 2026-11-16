/** Use from the existing CMS after login. Pass its Supabase client and the configured API origin. */
export function memberNetworkClient(apiOrigin, supabase) {
  const origin = new URL(apiOrigin);
  if (origin.protocol !== "https:" && origin.hostname !== "localhost")
    throw new Error("Use an HTTPS API origin");
  if (origin.pathname !== "/" || origin.search || origin.hash)
    throw new Error("Expected an origin");
  return async function request(path, options = {}) {
    if (!path.startsWith("/api/admin/") || path.includes(".."))
      throw new Error("Unsupported Member Network route");
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session) throw new Error("CMS login required");
    const response = await fetch(new URL(path, origin), {
      ...options,
      credentials: "omit",
      headers: {
        ...options.headers,
        ...(options.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
        Authorization: `Bearer ${data.session.access_token}`,
      },
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error || "Member Network request failed");
    return result;
  };
}
