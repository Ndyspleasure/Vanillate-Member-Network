import { loadConfig } from "../src/config.js";
import { database, one } from "../src/db.js";
import { discord } from "../src/discord.js";
let config, db;
let failed = false;
function result(name, ok) {
  console.info(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) failed = true;
}
result("Node.js 24+", Number(process.versions.node.split(".")[0]) >= 24);
try {
  config = loadConfig();
  result("Environment and OAuth redirect configuration", true);
} catch (error) {
  result("Environment and OAuth redirect configuration", false);
  if (error.issues)
    console.info(
      "Check variables:",
      [...new Set(error.issues.map((i) => i.path.join(".")))].join(", "),
    );
  else
    console.info("Check origin, HTTPS, application IDs and admin allowlist.");
}
if (config && !process.argv.includes("--offline")) {
  db = database(config.DATABASE_URL);
  try {
    const row = await one(
      db,
      "SELECT version FROM member_network.schema_versions WHERE version='002_member_retention'",
    );
    result("Database and required migration", !!row);
  } catch {
    result("Database and required migration", false);
  }
  try {
    const row = await one(
      db,
      "SELECT has_schema_privilege(current_user,'public','CREATE') AS can_create_public,(SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS elevated",
    );
    result(
      "Runtime database role is nonprivileged",
      !row.elevated && !row.can_create_public,
    );
  } catch {
    result("Runtime database role is nonprivileged", false);
  }
  try {
    await discord(config).verifyBot();
    result("Discord bot belongs to configured application", true);
  } catch {
    result("Discord bot belongs to configured application", false);
  }
  try {
    const response = await fetch(
      `${config.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/settings`,
      {
        headers: { apikey: config.SUPABASE_PUBLISHABLE_KEY },
        signal: AbortSignal.timeout(10000),
      },
    );
    result(
      "Supabase Auth is reachable with configured public key",
      response.ok,
    );
  } catch {
    result("Supabase Auth is reachable with configured public key", false);
  }
  await db.close();
}
console.info(
  "Live browser OAuth, target-guild permission and public HTTPS remain deployment acceptance checks.",
);
process.exitCode = failed ? 1 : 0;
