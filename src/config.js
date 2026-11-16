import { z } from "zod";
const uuidList = z
  .string()
  .default("")
  .transform((s) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.uuid()));
export function loadConfig(env = process.env) {
  const c = z
    .object({
      NODE_ENV: z
        .enum(["development", "production", "test"])
        .default("development"),
      PORT: z.coerce.number().int().min(1).max(65535).default(3000),
      APP_BASE_URL: z.url(),
      DATABASE_URL: z.string().min(1),
      CMS_ORIGIN: z.preprocess(
        (v) => (v === "" ? undefined : v),
        z.url().optional(),
      ),
      SUPABASE_URL: z.url(),
      SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
      DISCORD_APPLICATION_ID: z.string().regex(/^\d{17,20}$/),
      DISCORD_CLIENT_ID: z.string().regex(/^\d{17,20}$/),
      DISCORD_CLIENT_SECRET: z.string().min(1),
      DISCORD_BOT_TOKEN: z.string().min(1),
      DISCORD_REDIRECT_URI: z.url(),
      TOKEN_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
      ADMIN_USER_IDS: uuidList,
      VIEWER_USER_IDS: uuidList,
      AUTO_JOIN_ENABLED: z
        .enum(["true", "false"])
        .default("false")
        .transform((x) => x === "true"),
    })
    .parse(env);
  if (c.DISCORD_APPLICATION_ID !== c.DISCORD_CLIENT_ID)
    throw new Error("Discord application and client must match");
  const base = new URL(c.APP_BASE_URL);
  if (base.pathname !== "/" || base.search || base.hash)
    throw new Error("APP_BASE_URL must be an origin");
  if (
    new URL(c.DISCORD_REDIRECT_URI).href !==
    new URL("/auth/discord/callback", base).href
  )
    throw new Error("Redirect URI must match callback on APP_BASE_URL");
  if (
    c.NODE_ENV === "production" &&
    (base.protocol !== "https:" || !c.SUPABASE_URL.startsWith("https:"))
  )
    throw new Error("HTTPS required");
  if (!c.ADMIN_USER_IDS.length)
    throw new Error("Configure at least one server-managed admin user ID");
  return c;
}
