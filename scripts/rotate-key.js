import { database, audit } from "../src/db.js";
import { vault } from "../src/crypto.js";
const key = process.env.TOKEN_ENCRYPTION_KEY,
  previous = (process.env.TOKEN_ENCRYPTION_PREVIOUS_KEYS || "")
    .split(",")
    .filter(Boolean);
if (
  !process.env.DATABASE_URL ||
  ![key, ...previous].every((k) => /^[a-fA-F0-9]{64}$/.test(k)) ||
  !previous.length
)
  throw new Error("Database URL, current key and previous keys required");
const db = database(process.env.DATABASE_URL),
  crypt = vault(key, previous);
try {
  await db.tx(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(18662,2)");
    for (const [table, pk, column, context] of [
      ["connections", "member_id", "encrypted_tokens", "member_id"],
      ["sessions", "token_hash", "credential", "subject"],
    ]) {
      const rows = (
        await tx.query(
          `SELECT ${pk},${column},${context} FROM member_network.${table} WHERE ${column} IS NOT NULL FOR UPDATE`,
        )
      ).rows;
      for (const row of rows)
        await tx.query(
          `UPDATE member_network.${table} SET ${column}=$2 WHERE ${pk}=$1`,
          [
            row[pk],
            crypt.encrypt(
              crypt.decrypt(row[column], row[context]),
              row[context],
            ),
          ],
        );
    }
    await audit(tx, "maintenance", "credentials.rotate");
  });
  console.info(
    "Credential rotation completed. Verify startup before removing previous keys.",
  );
} catch {
  console.error(
    "Credential rotation failed; transaction rolled back. Keep previous keys.",
  );
  process.exitCode = 1;
} finally {
  await db.close();
}
