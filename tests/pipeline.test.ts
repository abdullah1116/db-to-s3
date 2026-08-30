import { describe, expect, test } from "bun:test";
import { buildKey, MIN_VALID_BYTES } from "../src/pipeline.ts";
import { verifyObject } from "../src/integrity.ts";
import { SignalManager } from "../src/signals.ts";

describe("buildKey", () => {
  test("formats UTC date into db/YYYY-MM-DD/dump.sql.zst (no leading slash)", () => {
    const d = new Date("2026-08-30T23:59:59Z");
    expect(buildKey("appdb", d)).toBe("appdb/2026-08-30/dump.sql.zst");
  });

  test("zero-pads month and day", () => {
    const d = new Date("2026-01-05T00:00:00Z");
    expect(buildKey("appdb", d)).toBe("appdb/2026-01-05/dump.sql.zst");
  });
});

describe("MIN_VALID_BYTES", () => {
  test("is 1024 (1KB abort threshold)", () => {
    expect(MIN_VALID_BYTES).toBe(1024);
  });
});

describe("verifyObject", () => {
  const fakeS3 = (stat: { size: number; etag: string }) => ({
    stat: async () => stat,
  }) as any;

  test("passes when size matches and no md5 provided", async () => {
    const r = await verifyObject(fakeS3({ size: 5000, etag: '"abc"' }), "k", 5000);
    expect(r.ok).toBe(true);
    expect(r.actualBytes).toBe(5000);
  });

  test("fails on size mismatch", async () => {
    const r = await verifyObject(fakeS3({ size: 4000, etag: '"abc"' }), "k", 5000);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/size mismatch/);
  });

  test("compares ETag to client MD5 for objects under 5MB", async () => {
    const r = await verifyObject(fakeS3({ size: 4000, etag: '"deadbeef"' }), "k", 4000, "deadbeef");
    expect(r.ok).toBe(true);
  });

  test("fails on ETag mismatch for objects under 5MB", async () => {
    const r = await verifyObject(fakeS3({ size: 4000, etag: '"ffffffff"' }), "k", 4000, "deadbeef");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/etag mismatch/);
  });

  test("skips ETag comparison for multipart objects (>=5MB)", async () => {
    const r = await verifyObject(
      fakeS3({ size: 6 * 1024 * 1024, etag: '"not-an-md5-123"' }),
      "k",
      6 * 1024 * 1024,
      "deadbeef",
    );
    expect(r.ok).toBe(true);
  });
});

describe("SignalManager", () => {
  test("starts not aborted", () => {
    const sm = new SignalManager();
    expect(sm.aborted).toBe(false);
    expect(sm.signal.aborted).toBe(false);
  });
});
