#!/usr/bin/env bash
# 2호기 신규·변경 종목 자동 검증 타이머 설치(멱등). 코드는 ~/5(kr/verification) 의 ops/verify/auto-verify.mjs 를 그대로 쓴다.
#   sudo bash ops/verify/install-auto-verify.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
install -m 755 "$here/verify-check.sh" /usr/local/bin/macro-verify-check
install -d -o ubuntu -g ubuntu -m 755 /var/lib/macro-verify
cat >/usr/local/bin/macro-auto-verify-wait <<'EOF'
#!/usr/bin/env bash
# 시작 전 대기 — DB 복사가 도는 중이거나 다른 적재·검증 프로세스(수동 작업)가 있으면 끝날 때까지(최대 90분) 기다린다
for i in $(seq 1 180); do
  if ! systemctl is-active --quiet macro-db-sync.service && ! pgrep -f "scripts/(populate-kr-da|verify-financials)\.mjs" >/dev/null; then exit 0; fi
  sleep 30
done
echo "다른 작업이 90분 넘게 끝나지 않아 오늘 자동 검증을 건너뜀" >&2
exit 1
EOF
chmod 755 /usr/local/bin/macro-auto-verify-wait
cat >/etc/systemd/system/macro-auto-verify.service <<'EOF'
[Unit]
Description=2호기 신규·변경 종목 자동 검증(대상 판정 → 한국 적재 → 검증, 결과 2호기 DB·/var/lib/macro-verify)
After=network-online.target mongod.service verify-dev.service macro-db-sync.service
Requires=mongod.service
[Service]
Type=oneshot
User=ubuntu
WorkingDirectory=/home/ubuntu/5
ExecStartPre=/usr/local/bin/macro-auto-verify-wait
ExecStart=/usr/bin/node ops/verify/auto-verify.mjs
Nice=10
TimeoutStartSec=6h
EOF
cat >/etc/systemd/system/macro-auto-verify.timer <<'EOF'
[Unit]
Description=자동 검증 매일 06:00 KST(DB 복사 05:30 뒤) + 11:00(KRX 전 거래일 게시 뒤 — 종료코드 3 종목 재실행·남은 대상)
[Timer]
OnCalendar=*-*-* 06:00:00 Asia/Seoul
OnCalendar=*-*-* 11:00:00 Asia/Seoul
Persistent=true
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now macro-auto-verify.timer
systemctl list-timers macro-auto-verify.timer --no-pager
