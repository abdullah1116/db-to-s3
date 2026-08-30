import { loadConfig, type AppConfig } from "./config.ts";
import { checkDbReachable, checkS3Reachable } from "./preflight.ts";
import { runPipeline, buildKey, MIN_VALID_BYTES, type PipelineResult } from "./pipeline.ts";
import { verifyObject, type IntegrityResult } from "./integrity.ts";
import { planPrune } from "./retention.ts";
import { SignalManager } from "./signals.ts";
import { S3Client } from "bun";

async function main(): Promise<number> {
  let cfg: AppConfig;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error(`[config] ${(err as Error).message}`);
    return 1;
  }

  const signals = new SignalManager();
  const s3 = new S3Client({
    accessKeyId: cfg.s3.accessKeyId,
    secretAccessKey: cfg.s3.secretAccessKey,
    bucket: cfg.s3.bucket,
    region: cfg.s3.region,
  });

  // P1: pre-flight
  try {
    await checkDbReachable(cfg);
    await checkS3Reachable(s3);
  } catch (err) {
    console.error(`[preflight] ${(err as Error).message}`);
    return 1;
  }

  const key = buildKey(cfg.db.name, new Date());

  // P2: stream dump -> zstd -> S3
  let result: PipelineResult;
  try {
    result = await runPipeline(cfg, s3, key, signals);
  } catch (err) {
    console.error(`[pipeline] ${(err as Error).message}`);
    try {
      await s3.delete(key);
    } catch {
      // best effort
    }
    return 1;
  }

  // P3: verify
  const dumpOk = result.dumpExitCode === 0;
  const zstdOk = result.zstdExitCode === 0;
  const sizeOk = result.compressedBytes >= MIN_VALID_BYTES;
  if (!dumpOk || !zstdOk || !sizeOk) {
    console.error(
      `[verify] dump=${result.dumpExitCode} zstd=${result.zstdExitCode} bytes=${result.compressedBytes}`,
    );
    try {
      await s3.delete(key);
    } catch {
      // best effort
    }
    return 1;
  }

  let integrity: IntegrityResult;
  try {
    integrity = await verifyObject(s3, key, result.compressedBytes);
  } catch (err) {
    console.error(`[verify] stat failed: ${(err as Error).message}`);
    try {
      await s3.delete(key);
    } catch {
      // best effort
    }
    return 1;
  }
  if (!integrity.ok) {
    console.error(`[verify] ${integrity.reason}`);
    try {
      await s3.delete(key);
    } catch {
      // best effort
    }
    return 1;
  }

  // P4: retention prune
  try {
    const prefix = `${cfg.db.name}/`;
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await s3.list({ prefix, maxKeys: 1000, continuationToken: token });
      for (const c of page.contents ?? []) keys.push(c.key);
      token = page.nextContinuationToken;
    } while (token);

    const batches = planPrune(keys, new Date(), cfg.retention.dailyDays, cfg.retention.anchorDay);
    let pruned = 0;
    for (const batch of batches) {
      for (const k of batch) {
        await s3.delete(k);
        pruned++;
      }
    }
    console.log(`[retention] pruned ${pruned} object(s)`);
  } catch (err) {
    console.error(`[retention] ${(err as Error).message}`);
    return 1;
  }

  console.log(`[backup] success: ${key} (${result.compressedBytes} bytes)`);
  return 0;
}

const code = await main();
process.exit(code);
