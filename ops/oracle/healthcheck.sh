#!/usr/bin/env bash
# 오라클 서버 자체 점검(2026-10-03, 오너 지시 — 관리가 필요할 때 즉시 알림).
# systemd 타이머(macro-health.timer)가 10분마다 root 로 실행한다.
#
# 점검 항목마다 상태를 기억해 두고, "정상 → 문제" 로 바뀔 때만 알림을 연다:
#   - GitHub 이슈(라벨 ops-alert, 제목 "[ops-alert][1호기] 항목키: 내용") — 다음 대화에서 Claude 가 먼저 확인한다
#   - 텔레그램 봇 메시지
# "문제 → 정상" 으로 돌아오면 이슈를 닫고 해결 메시지를 보낸다. 같은 문제를 10분마다 반복해서 알리지 않는다.
#
# 알림 함수는 같은 폴더 alert-lib.sh(2호기 healthcheck-peer.sh 와 공용).
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
DOMAIN="${OPS_DOMAIN:-macro-insights.duckdns.org}"
HOST=$(hostname)
ALERT_TAG=1호기
ALERT_SOURCE=healthcheck.sh
# shellcheck source=alert-lib.sh
. "$(dirname "$(readlink -f "$0")")/alert-lib.sh"

if [ "${1:-}" = "--test" ]; then
  run_test
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

# 한국 재무(OpenDART) 동작 — 2026-10-05 검증 작업이 같은 DART 키의 일일 한도를 넘겨 운영 한국 재무가 멈췄는데 아무도 몰랐다(오너 지적).
# 운영 화면 경로를 그대로 불러 429(한도 초과)·5xx 면 바로 알림. 디스크 캐시 덕에 DART 실제 요청은 30분에 1건 남짓.
code=$(curl -s -o /tmp/hc-dart.json -m 60 -w '%{http_code}' "http://127.0.0.1:8080/api/markets/kr/005930/financials?period=annual" || echo 000)
check dart-kr "$([ "$code" = 200 ] && echo 1 || echo 0)" "한국 재무(OpenDART) 조회 실패(HTTP ${code}) $(head -c 120 /tmp/hc-dart.json 2>/dev/null) — 한도 초과(429)면 검증·적재 작업이 같은 키를 쓰는지 확인"

# 설정 백업(config-backup.sh, 매일 05:40 KST → 2호기) — 마지막 성공이 26시간 넘으면 알림
if [ -f "$STATE_DIR/.config-backup-ok" ]; then
  bk_age=$(( ($(date +%s) - $(stat -c %Y "$STATE_DIR/.config-backup-ok")) / 3600 ))
else
  bk_age=999
fi
check config-backup "$([ "$bk_age" -le 26 ] && echo 1 || echo 0)" "설정 백업이 ${bk_age}시간째 성공하지 못했습니다 — sudo journalctl -u macro-config-backup -n 50"

# 2호기 검증 결과 가져오기(verify-pull.sh, 매일 08:30 KST) — 가져오기 성공 26시간 초과, 결과 자체가 30시간 넘게 안 바뀌면 알림
#   (가져오기 실패 회차는 위 예약 작업 항목 job-macro-verify-pull 로도 알림)
vp_age=999
[ -f "$STATE_DIR/.verify-pull-ok" ] && vp_age=$(( ($(date +%s) - $(stat -c %Y "$STATE_DIR/.verify-pull-ok")) / 3600 ))
check verify-pull "$([ "$vp_age" -le 26 ] && echo 1 || echo 0)" "2호기 검증 결과 가져오기가 ${vp_age}시간째 성공하지 못했습니다 — sudo journalctl -u macro-verify-pull -n 50"
vg=$(cat "$STATE_DIR/.verify-pull-generated" 2>/dev/null)
vg_age=999
[ -n "$vg" ] && vg_age=$(( ($(date +%s) - $(date -d "$vg" +%s 2>/dev/null || echo 0)) / 3600 ))
check verify-stale "$([ "$vg_age" -le 30 ] && echo 1 || echo 0)" "2호기 검증 결과가 ${vg_age}시간째 갱신되지 않았습니다(마지막 생성 ${vg:-없음}) — 2호기 검증 작업 확인"

# 11) 2호기(macro-verify, 검증 + IPO 운영) 감시(2026-10-05 상호 감시) — 연속 2회 실패해야 알림
#   - SSH 포트 응답
#   - 2호기 자체 점검(healthcheck-peer.sh)이 10분마다 쓰는 하트비트가 30분 넘게 갱신 안 되면 알림.
#     읽기는 전용 키(/opt/macro/ops/peer_ed25519)로 — 2호기 authorized_keys 가 이 키에 "하트비트 파일 출력" 강제 명령만 허용한다.
PEER_HOST="${HC_PEER_HOST:-${OPS_PEER_HOST:-140.83.48.57}}"
nc -z -w 5 "$PEER_HOST" 22 >/dev/null 2>&1 && ok=1 || ok=0
check2 peer-ssh "$ok" "2호기(${PEER_HOST}) SSH 포트 응답 없음 — 서버 정지·네트워크 확인"
hb=$(timeout 25 ssh -i /opt/macro/ops/peer_ed25519 -o BatchMode=yes -o ConnectTimeout=10   -o UserKnownHostsFile=/opt/macro/ops/peer_known_hosts -o StrictHostKeyChecking=yes "ubuntu@${PEER_HOST}" 2>/dev/null | head -c 300)
hb_ts=$(printf '%s' "$hb" | awk 'NR==1{print $1}')
if [ -n "$hb_ts" ] && [ "$hb_ts" -eq "$hb_ts" ] 2>/dev/null; then
  age=$(( $(date +%s) - hb_ts ))
  check2 peer-heartbeat "$([ "$age" -le 1800 ] && echo 1 || echo 0)" "2호기 자체 점검이 $((age / 60))분째 멈춰 있습니다(마지막 $(date -d "@$hb_ts" '+%m-%d %H:%M')) — sudo systemctl status macro-peer-health.timer"
else
  check2 peer-heartbeat 0 "2호기 하트비트를 읽지 못했습니다 — 2호기 점검 미설치·SSH 키 문제"
fi

exit 0
