import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.ts";

let _pool: Pool | undefined;
let _db: ReturnType<typeof drizzle<typeof schema>> | undefined;

export function getDb() {
  if (_db) return _db;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  _pool = new Pool({ connectionString: url });
  // CRITICAL: pg's Pool emits 'error' on idle clients (e.g. DB restarted, NAT
  // dropped the TCP connection). Without a listener, Node escalates this to
  // an uncaughtException and the process dies — taking any open positions'
  // monitoring with it. Log loudly and let the pool transparently re-establish
  // a fresh client on the next query.
  _pool.on("error", (err) => {
    console.error(
      "[db] idle client error (pool will reconnect on next query):",
      err instanceof Error ? (err.stack ?? err.message) : err,
    );
  });
  _db = drizzle(_pool, { schema });
  return _db;
}

export async function closeDb(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = undefined;
    _db = undefined;
  }
}
