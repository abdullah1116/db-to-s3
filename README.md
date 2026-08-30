# mariadb-s3-backup

Nightly MariaDB backup streamed to S3: `mariadb-dump` → `zstd` → S3 multipart upload, with integrity verification, retention pruning, and SMTP failure alerts. Runs as a one-shot Docker container triggered by a systemd timer.

## How it works

1. `backup-mariadb.timer` fires daily at 00:00 UTC (`Persistent=true` catches missed runs).
2. `backup-mariadb.service` (Type=oneshot) runs `docker compose up` in `/opt/mariadb-backup`.
3. Inside the container, `src/main.ts`:
   - **P1 preflight**: TCP-connect to MariaDB (5s timeout) + S3 list check.
   - **P2 stream**: `mariadb-dump --single-transaction --quick --master-data=2` → `zstd --ultra -22 --threads=0` → S3 multipart writer (8MB parts). Password via `MYSQL_PWD` env, never argv.
   - **P3 verify**: dump/zstd exit 0, compressed size ≥ 1KB, HEAD Size == tracked bytes (ETag == MD5 only for single-PUT <5MB objects).
   - **P4 retention**: list `DB_NAME/` prefix, prune keys older than `RETENTION_DAILY_DAYS` except the weekly anchor day.
4. On failure, `OnFailure=backup-failure-notify@%n.service` emails the last 20 journal lines via msmtp.

Object layout: `s3://BUCKET/{DB_NAME}/YYYY-MM-DD/dump.sql.zst` (UTC dates).

## Deploy

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

Exit codes: `0` success, `1` failure (config/preflight/dump/verify/retention), `130` interrupted by SIGTERM/SIGINT.

## Configuration

All configuration is via environment variables (see `deploy/.env.example`). Required: `DB_HOST`, `DB_USER`, `DB_PASS`, `DB_NAME`, `AWS_REGION`, `AWS_S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `ALERT_TO`. Optional: `DB_PORT=3306`, `ZSTD_LEVEL=22`, `RETENTION_DAILY_DAYS=30`, `WEEKLY_ANCHOR_DAY=0`, `SMTP_PORT=587`, `SMTP_SECURITY=starttls|ssl|none`.

## Development

```bash
bun install
bun test          # unit + MinIO-gated integration tests
bun run src/main.ts  # requires .env with real creds
```

MinIO integration tests auto-skip when `http://localhost:9000` is unreachable.