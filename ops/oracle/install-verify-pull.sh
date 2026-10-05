#!/usr/bin/env bash
# 1호기: 2호기 검증 결과 가져오기(verify-pull.sh) 설치 — 전용 읽기 키(없을 때만 생성) + 매일 08:30 KST 타이머.
# 사용: sudo bash /opt/macro/jobs/ops/oracle/install-verify-pull.sh → 출력된 공개키를 2호기 install-verify-share.sh 인자로.
set -euo pipefail
OPS=/opt/macro/ops
PEER_HOST="${OPS_PEER_HOST:-140.83.48.57}"
install -m 755 "$(dirname "$(readlink -f "$0")")/verify-pull.sh" "$OPS/verify-pull.sh"
[ -f "$OPS/verifypull_ed25519" ] || ssh-keygen -q -t ed25519 -N "" -C macro-verify-pull -f "$OPS/verifypull_ed25519"
chmod 600 "$OPS/verifypull_ed25519"
[ -s "$OPS/peer_known_hosts" ] || ssh-keyscan -t ed25519 "$PEER_HOST" > "$OPS/peer_known_hosts" 2>/dev/null

cat > /etc/systemd/system/macro-verify-pull.service <<'UNIT'
[Unit]
Description=2호기 검증 결과 가져오기 → 운영 verify_results
After=network-online.target docker.service

[Service]
Type=oneshot
ExecStart=/opt/macro/ops/verify-pull.sh
Nice=10
UNIT

cat > /etc/systemd/system/macro-verify-pull.timer <<'UNIT'
[Unit]
Description=2호기 검증 결과 가져오기 매일 08:30 KST

[Timer]
OnCalendar=*-*-* 08:30:00 Asia/Seoul
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now macro-verify-pull.timer
echo "2호기에 등록할 읽기 공개키: $(cat "$OPS/verifypull_ed25519.pub")"
systemctl list-timers macro-verify-pull.timer --no-pager | head -3
