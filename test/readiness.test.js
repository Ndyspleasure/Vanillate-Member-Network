import test from "node:test";
import assert from "node:assert/strict";
import { vault } from "../src/crypto.js";
import { loadConfig } from "../src/config.js";
import { worker } from "../src/worker.js";
import { config, adminId } from "./helpers.js";
test("Wispbyte allocated port and previous encryption keys are validated", () => {
  const env = {
    ...config,
    DATABASE_URL: "postgres://test",
    ADMIN_USER_IDS: adminId,
    VIEWER_USER_IDS: "",
    AUTO_JOIN_ENABLED: "false",
    PORT: "",
    SERVER_PORT: "9221",
  };
  assert.equal(loadConfig(env).PORT, 9221);
  assert.equal(loadConfig({ ...env, PORT: "4000" }).PORT, 4000);
  assert.throws(() => loadConfig({ ...env, SERVER_PORT: "bad" }));
  const oldKey = "a".repeat(64),
    newKey = "b".repeat(64),
    old = vault(oldKey).encrypt({ access: "private" }, "context");
  const mixed = vault(newKey, [oldKey]);
  assert.equal(mixed.decrypt(old, "context").access, "private");
  assert.equal(mixed.decrypt(old.split(":")[2], "context").access, "private");
  assert.throws(() => vault(newKey).decrypt(old, "context"));
});
test("wake during a busy worker cannot lose the request and sleep for fifteen minutes", async () => {
  let entered, release, next;
  let calls = 0;
  const firstEntered = new Promise((r) => (entered = r)),
    barrier = new Promise((r) => (release = r)),
    second = new Promise((r) => (next = r));
  const db = {
    query: async () => ({ rows: [] }),
    tx: async () => {
      calls++;
      if (calls === 1) {
        entered();
        await barrier;
      } else next();
      return false;
    },
  };
  const w = worker(db, null, null, { AUTO_JOIN_ENABLED: false });
  const running = w.start();
  await firstEntered;
  w.wake();
  release();
  await running;
  try {
    await Promise.race([
      second,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Wake lost")), 1000);
        timer.unref();
      }),
    ]);
    assert(calls >= 2);
  } finally {
    await w.stop();
  }
});
