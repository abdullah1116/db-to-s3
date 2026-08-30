import { describe, expect, test } from "bun:test";
import { loadConfig, ConfigError } from "../src/config.ts";

// Helper: build a full valid env object, then override fields for specific tests.
function validEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const base: Record<string, string> = {
    DB_HOST: "db.internal",
    DB_PORT: "3306",
    DB_USER: "backup",
    DB_PASS: "s3cret",
    DB_NAME: "appdb",
    AWS_REGION: "us-east-1",
    AWS_S3_BUCKET: "backups",
    AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
    AWS_SECRET_ACCESS_KEY: "secretkey",
    SMTP_HOST: "smtp.example.com",
    SMTP_USER: "alert@example.com",
    SMTP_PASS: "smtppass",
    SMTP_FROM: "backup@example.com",
    ALERT_TO: "ops@example.com",
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return base;
}

describe("loadConfig", () => {
  test("parses a complete valid env with defaults", () => {
    const cfg = loadConfig(validEnv());
    expect(cfg.db.host).toBe("db.internal");
    expect(cfg.db.port).toBe(3306);
    expect(cfg.db.user).toBe("backup");
    expect(cfg.db.pass).toBe("s3cret");
    expect(cfg.db.name).toBe("appdb");
    expect(cfg.s3.region).toBe("us-east-1");
    expect(cfg.s3.bucket).toBe("backups");
    expect(cfg.s3.accessKeyId).toBe("AKIAEXAMPLE");
    expect(cfg.s3.secretAccessKey).toBe("secretkey");
    // defaults
    expect(cfg.zstdLevel).toBe(22);
    expect(cfg.retention.dailyDays).toBe(30);
    expect(cfg.retention.anchorDay).toBe(0);
    expect(cfg.smtp.port).toBe(587);
    expect(cfg.smtp.security).toBe("starttls");
  });

  test("accepts explicit optional values", () => {
    const cfg = loadConfig(
      validEnv({
        ZSTD_LEVEL: "19",
        RETENTION_DAILY_DAYS: "14",
        WEEKLY_ANCHOR_DAY: "1",
        SMTP_PORT: "465",
        SMTP_SECURITY: "ssl",
      }),
    );
    expect(cfg.zstdLevel).toBe(19);
    expect(cfg.retention.dailyDays).toBe(14);
    expect(cfg.retention.anchorDay).toBe(1);
    expect(cfg.smtp.port).toBe(465);
    expect(cfg.smtp.security).toBe("ssl");
  });

  test("throws ConfigError naming the missing required field", () => {
    expect(() => loadConfig(validEnv({ DB_HOST: undefined }))).toThrow(/DB_HOST/);
    expect(() => loadConfig(validEnv({ DB_PASS: undefined }))).toThrow(/DB_PASS/);
    expect(() => loadConfig(validEnv({ AWS_S3_BUCKET: undefined }))).toThrow(/AWS_S3_BUCKET/);
  });

  test("throws ConfigError for invalid DB_PORT (non-integer / out of range)", () => {
    expect(() => loadConfig(validEnv({ DB_PORT: "abc" }))).toThrow(/DB_PORT/);
    expect(() => loadConfig(validEnv({ DB_PORT: "0" }))).toThrow(/DB_PORT/);
    expect(() => loadConfig(validEnv({ DB_PORT: "65536" }))).toThrow(/DB_PORT/);
  });

  test("throws ConfigError for invalid WEEKLY_ANCHOR_DAY (outside 0-6)", () => {
    expect(() => loadConfig(validEnv({ WEEKLY_ANCHOR_DAY: "7" }))).toThrow(/WEEKLY_ANCHOR_DAY/);
    expect(() => loadConfig(validEnv({ WEEKLY_ANCHOR_DAY: "-1" }))).toThrow(/WEEKLY_ANCHOR_DAY/);
  });

  test("throws ConfigError for invalid SMTP_SECURITY value", () => {
    expect(() => loadConfig(validEnv({ SMTP_SECURITY: "bogus" }))).toThrow(/SMTP_SECURITY/);
  });

  test("throws ConfigError for invalid RETENTION_DAILY_DAYS (non-positive)", () => {
    expect(() => loadConfig(validEnv({ RETENTION_DAILY_DAYS: "0" }))).toThrow(/RETENTION_DAILY_DAYS/);
  });

  test("throws ConfigError for invalid ZSTD_LEVEL (outside 1-22)", () => {
    expect(() => loadConfig(validEnv({ ZSTD_LEVEL: "0" }))).toThrow(/ZSTD_LEVEL/);
    expect(() => loadConfig(validEnv({ ZSTD_LEVEL: "23" }))).toThrow(/ZSTD_LEVEL/);
  });
});
