import type { AppConfig } from "./config.ts";
import type { S3Client } from "bun";

/**
 * Pre-flight checks run before any backup work begins.
 * - checkDbReachable: TCP connect to the MariaDB host:port with a timeout.
 * - checkS3Reachable: issue a ListObjects (maxKeys:1) to confirm the bucket is
 *   reachable and the credentials have ListBucket permission.
 */

export async function checkDbReachable(
  cfg: AppConfig,
  timeoutMs = 5000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(
          new Error(
            `DB connection to ${cfg.db.host}:${cfg.db.port} timed out after ${timeoutMs}ms`,
          ),
        );
      }
    }, timeoutMs);

    const conn = Bun.connect({
      hostname: cfg.db.host,
      port: cfg.db.port,
      socket: {
        open(sock) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            sock.end();
            resolve();
          }
        },
        error(_sock, err) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(err);
          }
        },
      },
    });

    conn.catch((err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

export async function checkS3Reachable(s3: S3Client): Promise<void> {
  await s3.list({ maxKeys: 1 });
}
