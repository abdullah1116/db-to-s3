/**
 * Configuration loading and validation.
 *
 * All secrets and settings come from the environment (Bun auto-loads `.env`).
 * Credentials are NEVER accepted via CLI arguments to avoid leaking them
 * through process listings (`/proc/<pid>/cmdline`).
 */

export class ConfigError extends Error {
  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "ConfigError";
  }
}

export interface DbConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  name: string;
}

export interface S3Config {
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface RetentionConfig {
  dailyDays: number;
  anchorDay: number; // 0 (Sunday) .. 6 (Saturday)
}

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  alertTo: string;
  security: "starttls" | "ssl" | "none";
}

export interface AppConfig {
  db: DbConfig;
  s3: S3Config;
  zstdLevel: number;
  retention: RetentionConfig;
  smtp: SmtpConfig;
}

function required(env: Record<string, string | undefined>, field: string): string {
  const v = env[field];
  if (v === undefined || v.trim() === "") {
    throw new ConfigError(field, "is required but was not set");
  }
  return v;
}

function optionalInt(
  env: Record<string, string | undefined>,
  field: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[field];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(field, `must be an integer in [${min}, ${max}], got "${raw}"`);
  }
  return n;
}

function optionalEnum<T extends string>(
  env: Record<string, string | undefined>,
  field: string,
  fallback: T,
  allowed: readonly T[],
): T {
  const raw = env[field];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new ConfigError(field, `must be one of ${allowed.join(", ")}, got "${raw}"`);
  }
  return raw as T;
}

export function loadConfig(env: Record<string, string | undefined> = Bun.env): AppConfig {
  const db: DbConfig = {
    host: required(env, "DB_HOST"),
    port: optionalInt(env, "DB_PORT", 3306, 1, 65535),
    user: required(env, "DB_USER"),
    pass: required(env, "DB_PASS"),
    name: required(env, "DB_NAME"),
  };

  const s3: S3Config = {
    region: required(env, "AWS_REGION"),
    bucket: required(env, "AWS_S3_BUCKET"),
    accessKeyId: required(env, "AWS_ACCESS_KEY_ID"),
    secretAccessKey: required(env, "AWS_SECRET_ACCESS_KEY"),
  };

  const retention: RetentionConfig = {
    dailyDays: optionalInt(env, "RETENTION_DAILY_DAYS", 30, 1, 3650),
    anchorDay: optionalInt(env, "WEEKLY_ANCHOR_DAY", 0, 0, 6),
  };

  const smtp: SmtpConfig = {
    host: required(env, "SMTP_HOST"),
    port: optionalInt(env, "SMTP_PORT", 587, 1, 65535),
    user: required(env, "SMTP_USER"),
    pass: required(env, "SMTP_PASS"),
    from: required(env, "SMTP_FROM"),
    alertTo: required(env, "ALERT_TO"),
    security: optionalEnum(env, "SMTP_SECURITY", "starttls", ["starttls", "ssl", "none"]),
  };

  return {
    db,
    s3,
    zstdLevel: optionalInt(env, "ZSTD_LEVEL", 22, 1, 22),
    retention,
    smtp,
  };
}
