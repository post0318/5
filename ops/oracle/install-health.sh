#!/usr/bin/env bash
# 서버 자체 점검(healthcheck.sh)을 10분마다 돌리는 systemd 타이머 + 보안 업데이트 자동 설치를 켠다.
# 사용: sudo bash /opt/macro/jobs/ops/oracle/install-health.sh   (같은 폴더의 healthcheck.sh 를 설치)
set -euo pipefail
install -d -m 755 /opt/macro/ops
SRC="$(dirname "$(readlink -f "$0")")"
install -m 755 "$SRC/healthcheck.sh" /opt/macro/ops/healthcheck.sh
install -m 755 "$SRC/alert-lib.sh" /opt/macro/ops/alert-lib.sh
install -m 755 "$SRC/usage-report.sh" /opt/macro/ops/usage-report.sh
install -d -m 755 /opt/macro/usage  # 외부 서비스 사용량 장부(src/lib/usage/ledger.mjs) — 앱 컨테이너·배치가 같이 쓴다
[ -f /opt/macro/ops/alert.env ] || install -m 600 /dev/null /opt/macro/ops/alert.env

# 2호기 하트비트 읽기 전용 키(2026-10-05 상호 감시) — 공개키를 2호기 install-health-peer.sh 인자로 넘겨 강제 명령으로 등록한다
PEER_HOST="${OPS_PEER_HOST:-140.83.48.57}"
[ -f /opt/macro/ops/peer_ed25519 ] || ssh-keygen -q -t ed25519 -N "" -C macro-peer-heartbeat -f /opt/macro/ops/peer_ed25519
chmod 600 /opt/macro/ops/peer_ed25519
[ -s /opt/macro/ops/peer_known_hosts ] || ssh-keyscan -t ed25519 "$PEER_HOST" > /opt/macro/ops/peer_known_hosts 2>/dev/null
echo "2호기에 등록할 공개키: $(cat /opt/macro/ops/peer_ed25519.pub)"

cat > /etc/systemd/system/macro-health.service <<'EOF'
[Unit]
Description=macro 서버 자체 점검
After=network-online.target docker.service

[Service]
Type=oneshot
ExecStart=/opt/macro/ops/healthcheck.sh
Nice=10
EOF

cat > /etc/systemd/system/macro-health.timer <<'EOF'
[Unit]
Description=macro 서버 자체 점검 10분마다

[Timer]
OnBootSec=3min
OnUnitActiveSec=10min
Persistent=true

[Install]
WantedBy=timers.target
EOF

# 외부 서비스 사용량 매일 보고(2026-10-06) — 08:00 KST 전날분 텔레그램
cat > /etc/systemd/system/macro-usage-report.service <<'EOF'
[Unit]
Description=외부 서비스 사용량 매일 보고
After=network-online.target docker.service

[Service]
Type=oneshot
ExecStart=/opt/macro/ops/usage-report.sh yesterday
Nice=10
EOF

cat > /etc/systemd/system/macro-usage-report.timer <<'EOF'
[Unit]
Description=외부 서비스 사용량 매일 보고 08:00 KST

[Timer]
OnCalendar=*-*-* 08:00:00 Asia/Seoul
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now macro-health.timer
systemctl enable --now macro-usage-report.timer

# 보안 업데이트 자동 설치(재부팅은 자동으로 하지 않고 점검이 알린다)
DEBIAN_FRONTEND=noninteractive apt-get install -y -q unattended-upgrades >/dev/null
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
systemctl list-timers macro-health.timer --no-pager | head -3
