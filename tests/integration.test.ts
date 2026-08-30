import { describe, expect, test } from "bun:test";
import { S3Client } from "bun";
import { verifyObject } from "../src/integrity.ts";
import { planPrune } from "../src/retention.ts";

const ENDPOINT = process.env.MINIO_ENDPOINT ?? "http://localhost:9000";
const BUCKET = "backups";

function client(): S3Client {
  return new S3Client({
    accessKeyId: "minioadmin",
    secretAccessKey: "minioadmin",
    bucket: BUCKET,
    region: "us-east-1",
    endpoint: ENDPOINT,
  });
}

async function minioReachable(): Promise<boolean> {
  try {
    const s3 = client();
    await s3.list({ maxKeys: 1 });
    return true;
  } catch {
    return false;
  }
}

describe("S3 integration (MinIO)", () => {
  const s3 = client();
  const run = minioReachable();

  test("writer uploads a small object and verifyObject passes", async () => {
    if (!(await run)) return; // skip when MinIO unavailable
    const key = "itest/small/dump.sql.zst";
    const data = new TextEncoder().encode("hello world backup payload");
    await s3.write(key, data, { type: "application/zstd" });

    const stat = await s3.stat(key);
    expect(stat.size).toBe(data.byteLength);

    const r = await verifyObject(s3, key, data.byteLength);
    expect(r.ok).toBe(true);
    expect(r.actualBytes).toBe(data.byteLength);

    await s3.delete(key);
  });

  test("writer multipart uploads a large object and verifyObject passes", async () => {
    if (!(await run)) return;
    const key = "itest/large/dump.sql.zst";
    // ~12MB to force multipart with 8MB partSize
    const chunk = new Uint8Array(1024 * 1024).fill(0x61); // 1MB of 'a'
    const file = s3.file(key, { type: "application/zstd" });
    const writer = file.writer({ partSize: 8 * 1024 * 1024, queueSize: 5, retry: 3 });
    let total = 0;
    for (let i = 0; i < 12; i++) {
      await writer.write(chunk);
      total += chunk.byteLength;
    }
    await writer.end();

    const stat = await s3.stat(key);
    expect(stat.size).toBe(total);

    const r = await verifyObject(s3, key, total);
    expect(r.ok).toBe(true);

    await s3.delete(key);
  });

  test("retention prune removes expired keys and keeps anchors", async () => {
    if (!(await run)) return;
    const now = new Date("2026-08-30T12:00:00Z"); // Sunday, anchorDay 0
    // Keys must match the production single-segment format: <db>/YYYY-MM-DD/dump.sql.zst
    const prefix = "itest/";
    const keys = [
      `${prefix}2026-08-30/dump.sql.zst`, // today -> keep
      `${prefix}2026-08-29/dump.sql.zst`, // age 1 -> keep
      `${prefix}2026-07-26/dump.sql.zst`, // age 35, Sunday -> keep (anchor)
      `${prefix}2026-07-27/dump.sql.zst`, // age 34, Monday -> prune
      `${prefix}2026-07-01/dump.sql.zst`, // age 60, Wednesday -> prune
    ];
    for (const k of keys) {
      await s3.write(k, new TextEncoder().encode("x"));
    }

    const batches = planPrune(keys, now, 30, 0);
    const toPrune = batches.flat();
    for (const k of toPrune) {
      await s3.delete(k);
    }

    // MinIO list can lag writes briefly; poll until the expected set is visible.
    const expected = [
      `${prefix}2026-07-26/dump.sql.zst`,
      `${prefix}2026-08-29/dump.sql.zst`,
      `${prefix}2026-08-30/dump.sql.zst`,
    ];
    let remaining: string[] = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      remaining = [];
      let token: string | undefined;
      do {
        const page = await s3.list({ prefix, maxKeys: 1000, continuationToken: token });
        for (const c of page.contents ?? []) remaining.push(c.key);
        token = page.nextContinuationToken;
      } while (token);
      if (remaining.sort().join(",") === expected.sort().join(",")) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(remaining.sort()).toEqual(expected);

    for (const k of remaining) await s3.delete(k);
  });
});
