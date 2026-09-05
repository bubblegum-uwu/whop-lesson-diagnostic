import { Pool } from "pg";
import type { DbConfig } from "../config.js";

/**
 * A small connection pool. In Cloud Run, `host` is a Cloud SQL unix socket
 * directory (`/cloudsql/INSTANCE_CONNECTION_NAME`) and `port` is ignored by
 * `pg` for socket connections; locally/in tests it's a normal TCP host:port.
 */
export function createPool(db: DbConfig): Pool {
  return new Pool({
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
    max: 5,
  });
}
