#!/usr/bin/env bash
set -euo pipefail

UNIT="${1:?usage: notify.sh <unit>}"
BODY="$(journalctl -u "${UNIT}" -n 20 --no-pager 2>/dev/null || true)"

case "${SMTP_SECURITY:-starttls}" in
  ssl) TLS=on ;;
  none) TLS=off ;;
  *) TLS=starttls ;;
esac

msmtp \
  --host="${SMTP_HOST}" \
  --port="${SMTP_PORT:-587}" \
  --from="${SMTP_FROM}" \
  --user="${SMTP_USER}" \
  --passwordenv=SMTP_PASS \
  --tls="${TLS}" \
  --auth=on \
  "${ALERT_TO}" <<EOF
Subject: [BACKUP] FAILED: ${UNIT}
From: ${SMTP_FROM}
To: ${ALERT_TO}

Backup unit ${UNIT} failed.

Recent journal output:
${BODY}
EOF
