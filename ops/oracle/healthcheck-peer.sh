#!/usr/bin/env bash
# 오라클 2호기(macro-verify — 검증 + IPO 운영, 격리) 점검(2026-10-05, 오너 지시 — "상태점검은 상호 감시해야 한다").
# systemd 타이머(macro-peer-health.timer)가 10분마다 root 로 실행한다. 설치는 install-health-peer.sh.
#
# 1) 1호기(운영) 감시 — 1호기가 죽으면 1호기 자체 점검은 알릴 수 없으므로 2호기가 바깥에서 본다. 연속 2회 실패해야 알림.
# 2) 2호기 자체 점검 — verify-dev·ipo@prod·ipo@dev, 검증 DB 복사(macro-db-check), 디스크·메모리·재부팅 필요.
# 3) 하트비트 — 끝까지 돌면 /var/lib/macro-health/heartbeat 에 시각을 쓴다. 1호기 healthcheck.sh 가 전용 키(강제 명령으로
#    이 파일 출력만 허용)로 읽어 30분 넘게 멈추면 알린다. 2호기에서 1호기로 가는 SSH 권한은 없다(2호기는 격리 서버).
#
# 알림 함수는 같은 폴더 alert-lib.sh(1호기와 같은 텔레그램 봇·GitHub 이슈, 제목 "[ops-alert][2호기] …").
# 설정: /opt/macro-health/alert.env (권한 600) — OPS_TG_BOT_TOKEN·OPS_TG_CHAT_ID·OPS_GH_TOKEN·OPS_GH_REPO 만.
# 시험: --test(알림 경로), HC_DOMAIN=틀린주소(1호기 감시 실패 흉내 — 2회 실행해야 알림).
set -uo pipefail

ENV_FILE=/opt/macro-health/alert.env
STATE_DIR=/var/lib/macro-health
mkdir -p "$STATE_DIR"
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
DOMAIN="${HC_DOMAIN:-macro-insights.duckdns.org}"   # 1호기 운영 도메인
PEER_IP="${HC_PEER_IP:-161.33.9.115}"                # 1호기 IP
HOST=$(hostname)
ALERT_TAG=2호기
ALERT_SOURCE=healthcheck-peer.sh
# shellcheck source=alert-lib.sh
. "$(dirname "$(readlink -f "$0")")/alert-lib.sh"

if [ "${1:-}" = "--test" ]; then
  run_test
  exit 0
fi

# ── 1호기(운영) 감시 ──
code=$(curl -s -o /dev/null -m 20 -w '%{http_code}' "https://${DOMAIN}/api/auth/me" || echo 000)
check2 op-https "$([ "$code" = 200 ] && echo 1 || echo 0)" "운영 사이트 https://${DOMAIN} 접속 실패(HTTP ${code}) — 1호기 정지·Caddy·DNS 확인"

code=$(curl -s -o /tmp/hc-peer-dart.json -m 60 -w '%{http_code}' "https://${DOMAIN}/api/markets/kr/005930/financials?period=annual" || echo 000)
check2 op-dart-kr "$([ "$code" = 200 ] && echo 1 || echo 0)" "운영 한국 재무(OpenDART) 조회 실패(HTTP ${code}) $(head -c 120 /tmp/hc-peer-dart.json 2>/dev/null)"

end=$(echo | timeout 20 openssl s_client -servername "$DOMAIN" -connect "${DOMAIN}:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
if [ -n "$end" ]; then
  days=$(( ($(date -d "$end" +%s) - $(date +%s)) / 86400 ))
  check2 op-cert-expiry "$([ "$days" -ge 14 ] && echo 1 || echo 0)" "운영 HTTPS 인증서가 ${days}일 뒤 만료됩니다(자동 갱신 실패 의심)"
fi

nc -z -w 5 "$PEER_IP" 22 >/dev/null 2>&1 && ok=1 || ok=0
check2 op-ssh "$ok" "1호기(${PEER_IP}) SSH 포트 응답 없음 — 서버 정지·네트워크 확인"

# ── 2호기 자체 ──
for u in verify-dev ipo@prod ipo@dev; do
  check "svc-$u" "$(systemctl is-active --quiet "$u" && echo 1 || echo 0)" "서비스 $u 가 멈췄습니다 — sudo journalctl -u $u -n 50"
done

# 검증 전용 MongoDB + 매일 복사(macro-db-sync 05:30) — 하루 한 번 작업이라 1회 실패로 알림
dbmsg=$(timeout 60 /usr/local/bin/macro-db-check 2>&1 | head -c 200) && ok=1 || ok=0
check db-sync "$ok" "검증 DB 점검 실패: ${dbmsg:-응답 없음} — sudo journalctl -u macro-db-sync -n 50"

disk=$(df --output=pcent / | tail -1 | tr -dc 0-9)
check disk "$([ "$disk" -lt 80 ] && echo 1 || echo 0)" "디스크 사용률 ${disk}%"

avail=$(awk '/MemAvailable/{a=$2}/MemTotal/{t=$2}END{print int(a*100/t)}' /proc/meminfo)
check memory "$([ "$avail" -ge 10 ] && echo 1 || echo 0)" "사용 가능한 메모리 ${avail}%"

check reboot-required "$([ -f /var/run/reboot-required ] && echo 0 || echo 1)" "보안 업데이트 적용을 위해 재부팅이 필요합니다"

# ── 하트비트(1호기가 읽는다) — "시각(초) ISO시각 열린알림목록" 한 줄 ──
open_keys=$(cd "$STATE_DIR" && ls -1 2>/dev/null | grep -v -e '^\.' -e '^heartbeat' | tr '\n' ',' | sed 's/,$//')
printf '%s %s %s\n' "$(date +%s)" "$(date -Is)" "${open_keys:-none}" > "$STATE_DIR/heartbeat.tmp"
chmod 644 "$STATE_DIR/heartbeat.tmp"
mv -f "$STATE_DIR/heartbeat.tmp" "$STATE_DIR/heartbeat"

exit 0
