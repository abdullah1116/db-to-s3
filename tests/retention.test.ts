import { describe, expect, test } from "bun:test";
import { classify, planPrune, parseKeyDate } from "../src/retention.ts";

// Reference UTC date: 2026-08-30 is a Sunday (anchorDay 0).
const NOW = new Date("2026-08-30T12:00:00Z");

function key(date: string): string {
  return `appdb/${date}/dump.sql.zst`;
}

describe("parseKeyDate", () => {
  test("extracts YYYY-MM-DD from a valid key", () => {
    expect(parseKeyDate(key("2026-08-30"))).toBe("2026-08-30");
  });

  test("returns null for malformed keys", () => {
    expect(parseKeyDate("appdb/not-a-date/dump.sql.zst")).toBeNull();
    expect(parseKeyDate("appdb/2026-13-99/dump.sql.zst")).toBeNull();
    expect(parseKeyDate("garbage")).toBeNull();
    expect(parseKeyDate("appdb/2026-08-30/")).toBeNull();
  });
});

describe("classify", () => {
  test("keeps all snapshots within the daily retention window", () => {
    // 2026-08-29 is 1 day old (Saturday) -> keep
    expect(classify(key("2026-08-29"), NOW, 30, 0)).toBe("keep");
    // 2026-08-01 is 29 days old -> keep
    expect(classify(key("2026-08-01"), NOW, 30, 0)).toBe("keep");
  });

  test("keeps the anchor-day snapshot beyond the daily window", () => {
    // 2026-07-26 is a Sunday (anchorDay 0), 35 days old -> keep (weekly forever)
    expect(classify(key("2026-07-26"), NOW, 30, 0)).toBe("keep");
  });

  test("prunes non-anchor snapshots beyond the daily window", () => {
    // 2026-07-27 is a Monday, 34 days old -> prune
    expect(classify(key("2026-07-27"), NOW, 30, 0)).toBe("prune");
    // 2026-07-25 is a Saturday, 36 days old -> prune
    expect(classify(key("2026-07-25"), NOW, 30, 0)).toBe("prune");
  });

  test("boundary: exactly dailyDays old is still kept", () => {
    // 2026-07-31 is 30 days old -> keep (age <= dailyDays)
    expect(classify(key("2026-07-31"), NOW, 30, 0)).toBe("keep");
  });

  test("boundary: dailyDays+1 old is pruned unless anchor day", () => {
    // 2026-07-30 is 31 days old, a Thursday -> prune
    expect(classify(key("2026-07-30"), NOW, 30, 0)).toBe("prune");
  });

  test("respects a non-Sunday anchor day", () => {
    // anchorDay 1 (Monday): 2026-07-27 (Monday, 34d) -> keep
    expect(classify(key("2026-07-27"), NOW, 30, 1)).toBe("keep");
    // anchorDay 1: 2026-07-26 (Sunday, 35d) -> prune
    expect(classify(key("2026-07-26"), NOW, 30, 1)).toBe("prune");
  });

  test("skips malformed keys (never prunes)", () => {
    expect(classify("appdb/not-a-date/dump.sql.zst", NOW, 30, 0)).toBe("skip");
    expect(classify("garbage", NOW, 30, 0)).toBe("skip");
  });
});

describe("planPrune", () => {
  test("returns only keys classified as prune", () => {
    const keys = [
      key("2026-08-29"), // keep (1d)
      key("2026-07-27"), // prune (34d, Monday)
      key("2026-07-26"), // keep (35d, Sunday anchor)
      key("2026-07-25"), // prune (36d, Saturday)
    ];
    const result = planPrune(keys, NOW, 30, 0);
    expect(result).toEqual([[key("2026-07-27"), key("2026-07-25")]]);
  });

  test("returns empty array when nothing to prune", () => {
    const keys = [key("2026-08-29"), key("2026-07-26")];
    expect(planPrune(keys, NOW, 30, 0)).toEqual([]);
  });

  test("batches deletions into chunks of at most 1000", () => {
    // 2500 keys all 40 days old on non-anchor days -> all prune
    const keys: string[] = [];
    for (let i = 0; i < 2500; i++) {
      // 2026-07-19 is a Sunday; use 2026-07-20 (Monday) onward pattern
      const day = 20 + (i % 5); // Mon-Fri, all non-anchor
      const date = `2026-07-${String(day).padStart(2, "0")}`;
      keys.push(key(date));
    }
    const batches = planPrune(keys, NOW, 30, 0, 1000);
    expect(batches.length).toBe(3);
    expect(batches[0].length).toBe(1000);
    expect(batches[1].length).toBe(1000);
    expect(batches[2].length).toBe(500);
  });
});
