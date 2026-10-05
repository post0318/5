#!/usr/bin/env bash
# 앱의 /api/cron/* 라우트를 서버 안에서 직접 부른다. 사용: call-cron.sh <경로+쿼리> [타임아웃초] [POST 본문(JSON)]
#
# 성공 판정(2026-10-06, 전수조사 구멍 #7 — 예전엔 HTTP 200 이면 무조건 성공이라 macro-kr-fg 가 200 + {ok:false,"… 다시 시도"} 를 놓쳤다):
#   - HTTP 200 이 아니면 실패(exit 1)
#   - 본문이 JSON 객체이고 ok:false 이거나 error 가 있으면 실패(exit 1). 단 holiday:true(휴장일이라 데이터 없음)는 정상
#   - retry:true("아직 미공개 — 다시 시도" 성격)이고 환경변수 CRON_RETRY_TIMER 가 있으면 그 타이머(1시간 뒤 1회 재시도)를 걸고 exit 0.
#     재시도 서비스는 CRON_RETRY_TIMER 없이 돌므로 또 실패하면 그대로 실패(exit 1) → healthcheck 가 알린다.
#   - 성공했고 CRON_RETRY_TIMER 가 있으면 재시도 서비스의 지난 실패 상태를 지운다(healthcheck 알림 자동 해제)
set -uo pipefail
SECRET=$(grep -E "^CRON_SECRET=" /opt/macro/app.env | cut -d= -f2-)
OUT=$(mktemp)
if [ -n "${3:-}" ]; then
  code=$(curl -s -o "$OUT" -w "%{http_code}" -m "${2:-600}" -X POST -H "Authorization: Bearer ${SECRET}" -H "content-type: application/json" -d "$3" "http://127.0.0.1:8080$1")
else
  code=$(curl -s -o "$OUT" -w "%{http_code}" -m "${2:-600}" -H "Authorization: Bearer ${SECRET}" "http://127.0.0.1:8080$1")
fi
echo "$1 → HTTP $code $(head -c 300 "$OUT")"
# 본문 판정: ok | holiday | fail | retry (JSON 이 아니거나 객체가 아니면 ok — 판정 근거 없음)
verdict=$(python3 - "$OUT" <<'PY' 2>/dev/null || echo ok
import json, sys
try:
    b = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    print("ok"); sys.exit()
if not isinstance(b, dict):
    print("ok")
elif b.get("holiday") is True:
    print("holiday")
elif b.get("ok") is False or b.get("error") not in (None, ""):
    print("retry" if b.get("retry") is True else "fail")
else:
    print("ok")
PY
)
rm -f "$OUT"
if [ "$code" != 200 ]; then
  exit 1
fi
case "$verdict" in
  ok)
    [ -n "${CRON_RETRY_TIMER:-}" ] && systemctl reset-failed "${CRON_RETRY_TIMER%.timer}.service" 2>/dev/null
    exit 0 ;;
  holiday)
    echo "휴장일 — 데이터 없음이 정상"
    [ -n "${CRON_RETRY_TIMER:-}" ] && systemctl reset-failed "${CRON_RETRY_TIMER%.timer}.service" 2>/dev/null
    exit 0 ;;
  retry)
    if [ -n "${CRON_RETRY_TIMER:-}" ] && systemctl restart "$CRON_RETRY_TIMER"; then
      echo "응답이 '다시 시도' — ${CRON_RETRY_TIMER} 로 1회 재시도 예약"
      exit 0
    fi
    echo "응답이 '다시 시도'인데 재시도 예약 없음(재시도 회차이거나 CRON_RETRY_TIMER 없음) — 실패"
    exit 1 ;;
  *)
    echo "응답 본문이 실패를 알림(ok:false 또는 error)"
    exit 1 ;;
esac
