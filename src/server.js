import { loadConfig } from "./config.js";
import { database, one } from "./db.js";
import { vault } from "./crypto.js";
import { discord as discordClient } from "./discord.js";
import { identity as identityClient } from "./identity.js";
import { worker as makeWorker } from "./worker.js";
import { buildApp } from "./app.js";
import { maintenance } from "./maintenance.js";
let db, app, worker, cleanupTimer;
try {
  const config = loadConfig();
  db = database(config.DATABASE_URL);
  const crypt = vault(
    config.TOKEN_ENCRYPTION_KEY,
    config.TOKEN_ENCRYPTION_PREVIOUS_KEYS,
  );
  const discord = discordClient(config),
    identity = identityClient(config);
  const version = await one(
    db,
    "SELECT version FROM member_network.schema_versions WHERE version='002_member_retention'",
  );
  if (!version) throw new Error("Migrations required");
  await discord.verifyBot();
  worker = makeWorker(db, crypt, discord, config);
  app = await buildApp({ db, crypt, discord, identity, config, worker });
  app.addHook("onClose", async () => {
    clearInterval(cleanupTimer);
    await worker.stop();
    await db.close();
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () =>
      app.close().catch(() => {
        process.exitCode = 1;
      }),
    );
  await maintenance(db);
  cleanupTimer = setInterval(
    () =>
      maintenance(db).catch(() =>
        console.error("Daily retention cleanup failed"),
      ),
    86400000,
  );
  cleanupTimer.unref();
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  await worker.start();
  console.info("Member Network ready");
} catch {
  console.error(
    "Member Network startup failed. Run npm run preflight to identify the failing check.",
  );
  if (app) await app.close().catch(() => {});
  else if (db) await db.close().catch(() => {});
  process.exitCode = 1;
}
