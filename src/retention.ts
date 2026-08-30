/**
 * Retention engine — pure logic, no I/O.
 *
 * S3 is the source of truth. Object keys are `{database_name}/YYYY-MM-DD/dump.sql.zst`.
 * The date embedded in the KEY is authoritative (not LastModified), so retention is
 * deterministic and timezone-safe (all comparisons in UTC).
 *
 * Tier A (age <= dailyDays): keep ALL daily snapshots.
 * Tier B (age > dailyDays): keep ONLY the snapshot whose key-date weekday equals the
 *   weekly anchor day (default Sunday, 0). Everything else older than dailyDays is pruned.
 */

export type RetentionAction = "keep" | "prune" | "skip";

const KEY_RE = /^([^/]+)\/(\d{4}-\d{2}-\d{2})\/dump\.sql\.zst$/;

/**
 * Extract the `YYYY-MM-DD` date from a backup key, or null if the key is malformed.
 */
export function parseKeyDate(key: string): string | null {
  const m = KEY_RE.exec(key);
  if (!m) return null;
  const date = m[2];
  // Validate it is a real calendar date (rejects 2026-13-99, 2026-02-30, etc.)
  const [y, mo, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return date;
}

/**
 * Classify a single backup key against the retention policy.
 *
 * @param key       full S3 object key
 * @param now       reference time (UTC)
 * @param dailyDays daily retention window in days
 * @param anchorDay weekly anchor weekday, 0 (Sunday) .. 6 (Saturday)
 * @returns "keep" | "prune" | "skip" (skip = malformed key, never pruned)
 */
export function classify(
  key: string,
  now: Date,
  dailyDays: number,
  anchorDay: number,
): RetentionAction {
  const date = parseKeyDate(key);
  if (date === null) return "skip";

  const [y, mo, d] = date.split("-").map(Number);
  const keyDate = Date.UTC(y, mo - 1, d);
  const nowUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const ageDays = Math.floor((nowUtc - keyDate) / 86_400_000);

  if (ageDays <= dailyDays) return "keep";

  const weekday = new Date(keyDate).getUTCDay();
  return weekday === anchorDay ? "keep" : "prune";
}

/**
 * Compute the list of keys to delete, batched into chunks of at most `batchSize`
 * (S3 DeleteObjects accepts up to 1000 per request).
 *
 * @returns array of batches; each batch is an array of keys to delete.
 */
export function planPrune(
  keys: string[],
  now: Date,
  dailyDays: number,
  anchorDay: number,
  batchSize = 1000,
): string[][] {
  const toDelete = keys.filter((k) => classify(k, now, dailyDays, anchorDay) === "prune");
  const batches: string[][] = [];
  for (let i = 0; i < toDelete.length; i += batchSize) {
    batches.push(toDelete.slice(i, i + batchSize));
  }
  return batches;
}
