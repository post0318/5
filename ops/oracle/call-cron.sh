#!/usr/bin/env bash
# 앱의 /api/cron/* 라우트를 서버 안에서 직접 부른다. 사용: call-cron.sh <경로+쿼리> [타임아웃초] [POST 본문(JSON)]
set -uo pipefail
SECRET=$(grep -E "^CRON_SECRET=" /opt/macro/app.env | cut -d= -f2-)
OUT=$(mktemp)
if [ -n "${3:-}" ]; then
  code=$(curl -s -o "$OUT" -w "%{http_code}" -m "${2:-600}" -X POST -H "Authorization: Bearer ${SECRET}" -H "content-type: application/json" -d "$3" "http://127.0.0.1:8080$1")
else
  code=$(curl -s -o "$OUT" -w "%{http_code}" -m "${2:-600}" -H "Authorization: Bearer ${SECRET}" "http://127.0.0.1:8080$1")
fi
echo "$1 → HTTP $code $(head -c 300 "$OUT")"; rm -f "$OUT"
[ "$code" = 200 ]
