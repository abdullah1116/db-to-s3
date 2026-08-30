import type { AppConfig } from "./config.ts";
import type { S3Client } from "bun";
import type { SignalManager } from "./signals.ts";

export interface PipelineResult {
  key: string;
  compressedBytes: number;
  dumpExitCode: number | null;
  zstdExitCode: number | null;
}

/** Objects smaller than this are treated as failed/empty backups and aborted. */
export const MIN_VALID_BYTES = 1024;

/**
 * Build the S3 object key for a backup. The key date is the source of truth
 * for retention, so it is derived from the UTC calendar date. S3 keys must not
 * have a leading slash (MinIO/S3 strip it, which breaks prefix listing).
 */
export function buildKey(dbName: string, date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${dbName}/${y}-${m}-${d}/dump.sql.zst`;
}

/**
 * Stream mariadb-dump -> zstd -> S3 multipart upload.
 *
 * The DB password is passed via the MYSQL_PWD environment variable (never on
 * the command line, which would leak it through /proc). The writer auto-aborts
 * the multipart upload if a write fails, so a mid-stream error leaves no
 * visible partial object.
 */
export async function runPipeline(
  cfg: AppConfig,
  s3: S3Client,
  key: string,
  signals: SignalManager,
): Promise<PipelineResult> {
  const dump = Bun.spawn({
    cmd: [
      "mariadb-dump",
      "--single-transaction",
      "--quick",
      "--master-data=2",
      "--net-buffer-length=16384",
      "--max-allowed-packet=1G",
      "-h",
      cfg.db.host,
      "-P",
      String(cfg.db.port),
      "-u",
      cfg.db.user,
      cfg.db.name,
    ],
    env: { ...Bun.env, MYSQL_PWD: cfg.db.pass },
    stdout: "pipe",
    stderr: "pipe",
    signal: signals.signal,
  });
  signals.register(dump);

  const zstd = Bun.spawn({
    cmd: ["zstd", "--ultra", `-${cfg.zstdLevel}`, "--threads=0", "-c"],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    signal: signals.signal,
  });
  signals.register(zstd);

  // Pipe dump stdout into zstd stdin. If the dump fails, the pipe errors and
  // zstd's stdin closes; we swallow the rejection here and rely on the exit
  // code + byte-count checks in main.ts to detect the failure.
  dump.stdout.pipeTo(zstd.stdin).catch(() => {});

  const file = s3.file(key, { type: "application/zstd" });
  const writer = file.writer({
    partSize: 8 * 1024 * 1024,
    queueSize: 5,
    retry: 3,
  });

  let compressedBytes = 0;
  const reader = zstd.stdout.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      compressedBytes += value.byteLength;
      await writer.write(value);
    }
    await writer.end();
  } catch (err) {
    // Writer auto-aborts the multipart upload on error.
    throw err;
  }

  const dumpExitCode = await dump.exited;
  const zstdExitCode = await zstd.exited;

  return { key, compressedBytes, dumpExitCode, zstdExitCode };
}
