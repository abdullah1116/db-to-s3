# mariadb-s3-backup

Nightly MariaDB backup streamed to S3: `mariadb-dump` → `zstd` → S3 multipart upload, with integrity verification, retention pruning, and SMTP failure alerts. Runs as a one-shot Docker container triggered by a systemd timer.

## Features

- Streams a consistent dump through zstd compression directly into S3 — no intermediate disk file.
- Multipart upload (8 MB parts) with retries; a mid-stream failure auto-aborts the upload so no partial object is left visible.
- Verifies the uploaded object (byte count, and MD5 ETag for single-PUT objects) before reporting success.
- Prunes old backups per a deterministic retention policy (see below).
- Emails the last 20 journal lines on failure via msmtp.
- Hardened container: non-root user, read-only rootfs, tmpfs `/tmp`, memory limits.

## How it works

1. `backup-mariadb.timer` fires daily at 00:00 UTC (`Persistent=true` catches missed runs).
2. `backup-mariadb.service` (Type=oneshot) runs `docker compose up` in `/opt/mariadb-backup`.
3. Inside the container, `src/main.ts` runs a four-stage pipeline:
   - **P1 preflight** — TCP-connect to MariaDB (5 s timeout) and issue an S3 list check to confirm the bucket is reachable and credentials are valid.
   - **P2 stream** — `mariadb-dump --single-transaction --quick --master-data=2 --net-buffer-length=16384 --max-allowed-packet=1G` → `zstd --ultra -{ZSTD_LEVEL} --threads=0` → S3 multipart writer. The DB password is passed via the `MYSQL_PWD` environment variable, never on the command line.
   - **P3 verify** — dump and zstd exit 0, compressed size ≥ 1 KB, and the S3 object size matches the tracked byte count. For single-PUT objects (< 5 MB) the ETag (MD5) is also compared.
   - **P4 retention** — list the `DB_NAME/` prefix and prune keys per the retention policy.
4. On failure, `OnFailure=backup-failure-notify@%n.service` emails the last 20 journal lines via msmtp.

## Architecture

```
+------------------ systemd (host) -------------------+
|  backup-mariadb.timer                               |
|  OnCalendar=*-*-* 00:00:00 UTC, Persistent=true     |
|        |                                            |
|        v                                            |
|  backup-mariadb.service (Type=oneshot)              |
|  docker compose up --exit-code-from mariadb-backup  |
+------------------+----------------------------------+
                   |
                   v
+------------------ container ------------------------+
|  mariadb-s3-backup (non-root, read-only rootfs)     |
|  src/main.ts                                        |
|  P1 preflight                                       |
|    TCP connect -> MariaDB :3306 (5s timeout)        |
|    S3 list check -> bucket                           |
|        v                                            |
|  P2 stream                                          |
|    mariadb-dump --single-transaction --quick        |
|      --master-data=2 (password via MYSQL_PWD env)   |
|        v                                            |
|    zstd --ultra -{ZSTD_LEVEL} --threads=0           |
|        v                                            |
|    S3 multipart writer (8 MB parts)                 |
|        v                                            |
|    s3://BUCKET/{DB_NAME}/YYYY-MM-DD/dump.sql.zst    |
|        v                                            |
|  P3 verify                                          |
|    dump/zstd exit 0, size >= 1 KB,                  |
|    HEAD size match (ETag == MD5 if < 5 MB)          |
|        v                                            |
|  P4 retention                                       |
|    list DB_NAME/ prefix -> classify keep/prune      |
|    (<= dailyDays keep all; older keep only          |
|     WEEKLY_ANCHOR_DAY; malformed skipped)           |
|    -> DeleteObjects batches                          |
+------------------+----------------------------------+
                   |
                   v
              exit 0 (success)
  any stage fails -> exit 1
        |
        v
  OnFailure=backup-failure-notify@%n.service
        |
        v
  notify.sh -> msmtp -> SMTP email (last 20 journal lines)
  SIGTERM/SIGINT -> exit 130
```

## Object layout

```
s3://BUCKET/{DB_NAME}/YYYY-MM-DD/dump.sql.zst
```

Keys use UTC calendar dates with no leading slash. The date embedded in the key is the source of truth for retention (not `LastModified`), so pruning is deterministic and timezone-safe.

## Retention policy

- **Tier A** — backups with key-date age ≤ `RETENTION_DAILY_DAYS` (default 30): keep **all** daily snapshots.
- **Tier B** — backups older than `RETENTION_DAILY_DAYS`: keep **only** the snapshot whose key-date weekday equals `WEEKLY_ANCHOR_DAY` (default 0 = Sunday); everything else is pruned.
- Malformed keys (not matching `{db}/YYYY-MM-DD/dump.sql.zst` or not a real calendar date) are **skipped, never pruned**.

## Tech stack

- [Bun](https://bun.sh) runtime with the built-in `S3Client` (multipart writer).
- `mariadb-dump` (mariadb-client) and `zstd` installed in the runtime image.
- Docker Compose for the one-shot container; systemd timer + service for scheduling; msmtp for email.

## Quick Start

### 1. Install on the host

```bash
sudo mkdir -p /opt/mariadb-backup
sudo cp deploy/docker-compose.yml deploy/Dockerfile /opt/mariadb-backup/
sudo cp deploy/backup-mariadb.timer deploy/backup-mariadb.service deploy/backup-failure-notify@.service /etc/systemd/system/
sudo cp deploy/notify.sh /opt/mariadb-backup/notify.sh
sudo chmod 700 /opt/mariadb-backup/notify.sh
sudo cp deploy/.env.example /opt/mariadb-backup/.env
sudo chmod 600 /opt/mariadb-backup/.env
# edit /opt/mariadb-backup/.env with real credentials
sudo systemctl daemon-reload
sudo systemctl enable --now backup-mariadb.timer
```

The host needs `docker` + `docker compose` (v2) and `msmtp` installed.

### 2. External AWS setup (one-time)

**IAM policy** for the backup user (least privilege):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::my-backups",
        "arn:aws:s3:::my-backups/*"
      ]
    }
  ]
}
```

**Lifecycle rule** to abort orphaned multipart uploads (Bun has no AbortMultipartUpload API; a killed container can leave parts behind):

```
Bucket → Management → Lifecycle rules → Create rule
Name: abort-orphaned-multiparts
Scope: whole bucket
Actions: Abort incomplete multipart upload
Days after initiation: 1
```

## Configuration

All configuration is via environment variables (see `deploy/.env.example`). Bun auto-loads `.env`.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DB_HOST` | yes | — | MariaDB hostname |
| `DB_PORT` | no | `3306` | MariaDB port |
| `DB_USER` | yes | — | MariaDB user (needs `RELOAD` for `--master-data`) |
| `DB_PASS` | yes | — | MariaDB password (passed via `MYSQL_PWD`) |
| `DB_NAME` | yes | — | Database to back up |
| `AWS_REGION` | yes | — | S3 region |
| `AWS_S3_BUCKET` | yes | — | S3 bucket name |
| `AWS_ACCESS_KEY_ID` | yes | — | S3 access key |
| `AWS_SECRET_ACCESS_KEY` | yes | — | S3 secret key |
| `ZSTD_LEVEL` | no | `22` | zstd compression level, 1–22 (higher = smaller but slower) |
| `RETENTION_DAILY_DAYS` | no | `30` | Keep all backups within this many days, 1–3650 |
| `WEEKLY_ANCHOR_DAY` | no | `0` | Weekly anchor weekday, 0 (Sunday) – 6 (Saturday) |
| `SMTP_HOST` | yes | — | SMTP server for failure alerts |
| `SMTP_PORT` | no | `587` | SMTP port |
| `SMTP_USER` | yes | — | SMTP username |
| `SMTP_PASS` | yes | — | SMTP password |
| `SMTP_FROM` | yes | — | Sender address |
| `ALERT_TO` | yes | — | Recipient address |
| `SMTP_SECURITY` | no | `starttls` | `starttls`, `ssl`, or `none` |

## Run / verify

```bash
# Manual run (foreground, shows logs)
docker compose --project-directory /opt/mariadb-backup up --exit-code-from mariadb-backup --abort-on-container-exit

# Check the timer
systemctl list-timers backup-mariadb.timer

# Check the last run
systemctl status backup-mariadb.service
journalctl -u backup-mariadb.service -n 50

# Verify the object landed
aws s3 ls s3://my-backups/mydb/$(date -u +%F)/

# Verify retention pruning (should show daily backups + weekly anchors)
aws s3 ls s3://my-backups/mydb/
```

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Failure (config, preflight, dump, verify, or retention) |
| `130` | Interrupted by SIGTERM/SIGINT |

## Development

```bash
bun install
bun test          # unit + MinIO-gated integration tests
bun run src/main.ts  # requires .env with real credentials
```

MinIO integration tests auto-skip when `http://localhost:9000` is unreachable.
