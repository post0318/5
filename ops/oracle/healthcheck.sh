#!/usr/bin/env bash
# 오라클 서버 자체 점검(2026-10-03, 오너 지시 — 관리가 필요할 때 즉시 알림).
# systemd 타이머(macro-health.timer)가 10분마다 root 로 실행한다.
#
# 점검 항목마다 상태를 기억해 두고, "정상 → 문제" 로 바뀔 때만 알림을 연다:
#   - GitHub 이슈(라벨 ops-alert, 제목 "[ops-alert] 항목키: 내용") — 다음 대화에서 Claude 가 먼저 확인한다
#   - 텔레그램 봇 메시지
# "문제 → 정상" 으로 돌아오면 이슈를 닫고 해결 메시지를 보낸다. 같은 문제를 10분마다 반복해서 알리지 않는다.
#
# 설정: /opt/macro/ops/alert.env (권한 600)
#   OPS_GH_TOKEN=...   (post0318/5 Issues 읽기·쓰기만 가진 세분화 토큰)
#   OPS_GH_REPO=post0318/5
#   OPS_TG_BOT_TOKEN=...
#   OPS_TG_CHAT_ID=...
#   OPS_DOMAIN=macro-insights.duckdns.org
set -uo pipefail

ENV_FILE=/opt/macro/ops/alert.env
STATE_DIR=/var/lib/macro-health
mkdir -p "$STATE_DIR"
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
GH_REPO="${OPS_GH_REPO:-post0318/5}"
DOMAIN="${OPS_DOMAIN:-macro-insights.duckdns.org}"
HOST=$(hostname)

# 시험 발송: healthcheck.sh --test — 텔레그램 메시지 + GitHub 이슈를 열었다 바로 닫는다(알림 경로 확인용)
TEST_MODE=0
[ "${1:-}" = "--test" ] && TEST_MODE=1

tg() {
  [ -n "${OPS_TG_BOT_TOKEN:-}" ] && [ -n "${OPS_TG_CHAT_ID:-}" ] || return 0
  curl -fsS -m 15 -o /dev/null "https://api.telegram.org/bot${OPS_TG_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${OPS_TG_CHAT_ID}" --data-urlencode "text=$1" || true
}

gh_api() { # method path [json]
  [ -n "${OPS_GH_TOKEN:-}" ] || return 1
  local extra=()
  [ -n "${3:-}" ] && extra=(-H "Content-Type: application/json" -d "$3")
  curl -fsS -m 20 -X "$1" "https://api.github.com/repos/${GH_REPO}$2" \
    -H "Authorization: Bearer ${OPS_GH_TOKEN}" -H "Accept: application/vnd.github+json" "${extra[@]}"
}

json_str() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"; }

open_alert() { # key message
  local key="$1" msg="$2" num
  tg "🚨 [오라클 ${HOST}] ${key}: ${msg}"
  num=$(gh_api POST /issues "{\"title\":$(json_str "[ops-alert] ${key}: ${msg}"),\"labels\":[\"ops-alert\"],\"body\":$(json_str "오라클 서버 자체 점검(healthcheck.sh)이 $(date -Is) 에 감지했습니다.

- 항목: ${key}
- 내용: ${msg}
- 서버: ${HOST} (${DOMAIN})

정상으로 돌아오면 이 이슈는 자동으로 닫힙니다.")}" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["number"])' 2>/dev/null)
  echo "${num:-0}" > "$STATE_DIR/$key"
}

close_alert() { # key
  local key="$1" num
  num=$(cat "$STATE_DIR/$key" 2>/dev/null || echo 0)
  tg "✅ [오라클 ${HOST}] ${key}: 정상으로 돌아왔습니다"
  if [ "${num:-0}" != "0" ]; then
    gh_api POST "/issues/${num}/comments" "{\"body\":$(json_str "$(date -Is) 정상 복귀 확인 — 자동으로 닫습니다.")}" >/dev/null 2>&1
    gh_api PATCH "/issues/${num}" '{"state":"closed"}' >/dev/null 2>&1
  fi
  rm -f "$STATE_DIR/$key"
}

check() { # key ok(0/1) message
  local key="$1" ok="$2" msg="$3"
  if [ "$ok" = 0 ]; then
    [ -f "$STATE_DIR/$key" ] || open_alert "$key" "$msg"
  else
    [ -f "$STATE_DIR/$key" ] && close_alert "$key"
  fi
  return 0
}

if [ "$TEST_MODE" = 1 ]; then
  open_alert test "알림 시험 발송입니다(조치 불필요)"
  sleep 2
  close_alert test
  echo "시험 발송 완료(텔레그램 2건 + GitHub 이슈 열고 닫음)"
  exit 0
fi

# 1) 앱 컨테이너 실행 중
running=$(docker inspect -f '{{.State.Running}}' macro 2>/dev/null || echo false)
check container "$([ "$running" = true ] && echo 1 || echo 0)" "앱 컨테이너(macro)가 실행 중이 아닙니다"

# 2) 앱 응답(서버 내부)
code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' http://127.0.0.1:8080/api/auth/me || echo 000)
check app-local "$([ "$code" = 200 ] && echo 1 || echo 0)" "앱이 응답하지 않습니다(내부 HTTP ${code})"

# 3) 재시작 반복 — 직전 점검 이후 재시작 횟수가 늘었으면 문제
rc=$(docker inspect -f '{{.RestartCount}}' macro 2>/dev/null || echo 0)
prev=$(cat "$STATE_DIR/.restart-count" 2>/dev/null || echo "$rc")
echo "$rc" > "$STATE_DIR/.restart-count"
check restart-loop "$([ "$rc" -le "$prev" ] && echo 1 || echo 0)" "앱이 10분 사이 $((rc - prev))번 재시작했습니다(누적 ${rc})"

# 4) HTTPS(도메인·인증서 포함 바깥 경로)
code=$(curl -s -o /dev/null -m 15 -w '%{http_code}' "https://${DOMAIN}/api/auth/me" || echo 000)
check https "$([ "$code" = 200 ] && echo 1 || echo 0)" "https://${DOMAIN} 접속 실패(HTTP ${code})"

# 5) 인증서 만료 14일 전
end=$(echo | openssl s_client -servername "$DOMAIN" -connect "${DOMAIN}:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
if [ -n "$end" ]; then
  days=$(( ($(date -d "$end" +%s) - $(date +%s)) / 86400 ))
  check cert-expiry "$([ "$days" -ge 14 ] && echo 1 || echo 0)" "HTTPS 인증서가 ${days}일 뒤 만료됩니다(자동 갱신 실패 의심)"
fi

# 6) 디스크 80%
disk=$(df --output=pcent / | tail -1 | tr -dc 0-9)
check disk "$([ "$disk" -lt 80 ] && echo 1 || echo 0)" "디스크 사용률 ${disk}%"

# 7) 메모리 — 사용 가능 10% 미만
avail=$(awk '/MemAvailable/{a=$2}/MemTotal/{t=$2}END{print int(a*100/t)}' /proc/meminfo)
check memory "$([ "$avail" -ge 10 ] && echo 1 || echo 0)" "사용 가능한 메모리 ${avail}%"

# 8) 보안 업데이트 후 재부팅 필요
check reboot-required "$([ -f /var/run/reboot-required ] && echo 0 || echo 1)" "보안 업데이트 적용을 위해 재부팅이 필요합니다"

# 9) 예약 작업 실패(2026-10-04) — 수집·배치 서비스가 마지막 실행에서 실패한 상태면 알림, 다음 실행이 성공하면 자동 해제
for u in $(systemctl list-units --all --type=service --no-legend --plain 'research-*' 'macro-*' 'fin-*' 'news-*' 'weekly-report*' | awk '{print $1}'); do
  name=${u%.service}
  [ "$name" = macro-health ] && continue
  st=$(systemctl show -p Result --value "$u")
  check "job-$name" "$([ "$st" = success ] && echo 1 || echo 0)" "예약 작업 $name 실패(결과 $st) — sudo journalctl -u $name -n 50"
done

# 10) 텔레그램 상주 수신기
check telegram-listener "$(systemctl is-active --quiet macro-telegram-listener && echo 1 || echo 0)" "텔레그램 상주 수신기가 멈췄습니다"

exit 0
