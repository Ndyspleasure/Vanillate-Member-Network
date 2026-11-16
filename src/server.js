import { loadConfig } from "./config.js";
import { database } from "./db.js";
import { vault } from "./crypto.js";
import { discord as discordClient } from "./discord.js";
import { identity as identityClient } from "./identity.js";
import { worker as makeWorker } from "./worker.js";
import { buildApp } from "./app.js";
try {
  const config = loadConfig();
  const db = database(config.DATABASE_URL);
  const crypt = vault(config.TOKEN_ENCRYPTION_KEY);
  const discord = discordClient(config);
  const identity = identityClient(config);
  await db.query("SELECT id FROM member_network.members LIMIT 1");
  await discord.verifyBot();
  const worker = makeWorker(db, crypt, discord, config);
  const app = await buildApp({ db, crypt, discord, identity, config, worker });
  app.addHook("onClose", async () => {
    await worker.stop();
    await db.close();
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () =>
      app.close().catch(() => {
        process.exitCode = 1;
      }),
    );
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  await worker.start();
  console.info("Member Network ready");
} catch {
  console.error(
    "Member Network startup failed. Check configuration, schema and upstream availability.",
  );
  process.exitCode = 1;
}
