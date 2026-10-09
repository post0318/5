#!/usr/bin/env bash
# 외부 서비스 사용량 매일 보고(2026-10-06) — 매일 08:00 KST(macro-usage-report.timer) 전날 서비스별 요청 수·캐시 적중·상한 대비 %를
# 텔레그램 한 메시지로 보낸다. 내용은 앱 /api/cron/usage?day=yesterday&format=text(src/lib/usage/report.ts)가 만든다.
# 80% 즉시 알림은 healthcheck.sh(10분마다)가 맡는다. 사용: usage-report.sh [today|yesterday|YYYYMMDD]  (--print 면 보내지 않고 출력만)
set -uo pipefail
ENV_FILE=/opt/macro/ops/alert.env
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
DAY=yesterday; PRINT=0
for a in "$@"; do case "$a" in --print) PRINT=1 ;; *) DAY="$a" ;; esac; done
SECRET=$(grep -E "^CRON_SECRET=" /opt/macro/app.env | cut -d= -f2-)
OUT=$(mktemp)
code=$(curl -s -o "$OUT" -m 30 -w '%{http_code}' -H "Authorization: Bearer ${SECRET}" "http://127.0.0.1:8080/api/cron/usage?day=${DAY}&format=text" || echo 000)
if [ "$code" != 200 ]; then echo "사용량 조회 실패 HTTP $code $(head -c 300 "$OUT")"; rm -f "$OUT"; exit 1; fi
if [ "$PRINT" = 1 ]; then cat "$OUT"; rm -f "$OUT"; exit 0; fi
[ -n "${OPS_TG_BOT_TOKEN:-}" ] && [ -n "${OPS_TG_CHAT_ID:-}" ] || { echo "OPS_TG_* 없음(alert.env)"; cat "$OUT"; rm -f "$OUT"; exit 1; }
curl -fsS -m 15 -o /dev/null "https://api.telegram.org/bot${OPS_TG_BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${OPS_TG_CHAT_ID}" --data-urlencode "text@${OUT}"
rc=$?
cat "$OUT"; rm -f "$OUT"
exit $rc
