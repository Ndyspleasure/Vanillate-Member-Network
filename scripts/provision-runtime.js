// Run once with the migration connection. Runtime login itself is created by the database operator.
import { database } from "../src/db.js";
const role = process.env.RUNTIME_DATABASE_ROLE;
if (
  !/^[a-z][a-z0-9_]{2,62}$/.test(role || "") ||
  role === "postgres" ||
  role === "anon" ||
  role === "authenticated"
)
  throw new Error(
    "Set RUNTIME_DATABASE_ROLE to a dedicated existing backend login",
  );
if (!process.env.MIGRATION_DATABASE_URL)
  throw new Error("MIGRATION_DATABASE_URL required");
const db = database(process.env.MIGRATION_DATABASE_URL);
try {
  await db.tx(async (tx) => {
    const login = (
      await tx.query(
        "SELECT rolcanlogin,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname=$1",
        [role],
      )
    ).rows[0];
    if (
      !login?.rolcanlogin ||
      login.rolsuper ||
      login.rolbypassrls ||
      login.rolcreaterole ||
      login.rolcreatedb
    )
      throw new Error("Runtime login must be nonprivileged");
    await tx.query(
      `DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='member_network_runtime') THEN CREATE ROLE member_network_runtime NOLOGIN; END IF; END $$`,
    );
    const group = (
      await tx.query(
        "SELECT rolcanlogin,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname='member_network_runtime'",
      )
    ).rows[0];
    if (
      group.rolcanlogin ||
      group.rolsuper ||
      group.rolbypassrls ||
      group.rolcreaterole ||
      group.rolcreatedb
    )
      throw new Error("Unexpected existing runtime group");
    await tx.query(
      "GRANT USAGE ON SCHEMA member_network TO member_network_runtime",
    );
    const tables = [
      "members",
      "connections",
      "oauth_states",
      "sessions",
      "communities",
      "consents",
      "campaigns",
      "jobs",
      "audit",
      "runtime",
    ];
    for (const table of tables) {
      await tx.query(
        `GRANT SELECT,INSERT,UPDATE,DELETE ON member_network.${table} TO member_network_runtime`,
      );
      await tx.query(
        `DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='member_network' AND tablename='${table}' AND policyname='backend_runtime') THEN CREATE POLICY backend_runtime ON member_network.${table} FOR ALL TO member_network_runtime USING(true) WITH CHECK(true); END IF; END $$`,
      );
    }
    await tx.query(
      "GRANT SELECT ON member_network.schema_versions TO member_network_runtime",
    );
    await tx.query(
      `DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='member_network' AND tablename='schema_versions' AND policyname='backend_runtime_read') THEN CREATE POLICY backend_runtime_read ON member_network.schema_versions FOR SELECT TO member_network_runtime USING(true); END IF; END $$`,
    );
    // Identifier is strictly validated above; never interpolate a password.
    await tx.query(`GRANT member_network_runtime TO "${role}"`);
  });
  console.info(
    "Dedicated backend role provisioned for Member Network schema only",
  );
} catch {
  console.error(
    "Role provisioning failed; transaction rolled back. Check dedicated login and migration privileges.",
  );
  process.exitCode = 1;
} finally {
  await db.close();
}
