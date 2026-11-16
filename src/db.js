import pg from "pg";
export function database(url) {
  const pool = new pg.Pool({
    connectionString: url,
    max: 5,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
  });
  return {
    query: (sql, args) => pool.query(sql, args),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
export const one = async (db, sql, args = []) =>
  (await db.query(sql, args)).rows[0];
export async function audit(db, actor, action, entity = null, detail = {}) {
  await db.query(
    "INSERT INTO member_network.audit(actor,action,entity,detail) VALUES ($1,$2,$3,$4)",
    [actor, action, entity, JSON.stringify(detail)],
  );
}
