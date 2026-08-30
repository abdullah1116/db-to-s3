import type { S3Client } from "bun";

export interface IntegrityResult {
  ok: boolean;
  expectedBytes: number;
  actualBytes: number;
  reason?: string;
}

/**
 * Verify a completed S3 object against the byte count we tracked while
 * streaming. For single-PUT objects (< 5MB) the ETag is the MD5 of the
 * content, so we additionally compare it to the client-side MD5 when
 * available. Multipart objects (>= 5MB) have a non-MD5 ETag and are checked
 * by size only.
 */
export async function verifyObject(
  s3: S3Client,
  key: string,
  expectedBytes: number,
  clientMd5?: string,
): Promise<IntegrityResult> {
  const stat = await s3.stat(key);
  if (stat.size !== expectedBytes) {
    return {
      ok: false,
      expectedBytes,
      actualBytes: stat.size,
      reason: `size mismatch: expected ${expectedBytes}, got ${stat.size}`,
    };
  }

  if (expectedBytes < 5 * 1024 * 1024 && clientMd5) {
    const etag = stat.etag.replace(/^"|"$/g, "");
    if (etag.toLowerCase() !== clientMd5.toLowerCase()) {
      return {
        ok: false,
        expectedBytes,
        actualBytes: stat.size,
        reason: `etag mismatch: expected ${clientMd5}, got ${etag}`,
      };
    }
  }

  return { ok: true, expectedBytes, actualBytes: stat.size };
}
