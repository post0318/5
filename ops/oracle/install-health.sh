#!/usr/bin/env bash
# 서버 자체 점검(healthcheck.sh)을 10분마다 돌리는 systemd 타이머 + 보안 업데이트 자동 설치를 켠다.
# 사용: sudo bash /opt/macro/jobs/ops/oracle/install-health.sh   (같은 폴더의 healthcheck.sh 를 설치)
set -euo pipefail
install -d -m 755 /opt/macro/ops
install -m 755 "$(dirname "$(readlink -f "$0")")/healthcheck.sh" /opt/macro/ops/healthcheck.sh
[ -f /opt/macro/ops/alert.env ] || install -m 600 /dev/null /opt/macro/ops/alert.env

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

systemctl daemon-reload
systemctl enable --now macro-health.timer

# 보안 업데이트 자동 설치(재부팅은 자동으로 하지 않고 점검이 알린다)
DEBIAN_FRONTEND=noninteractive apt-get install -y -q unattended-upgrades >/dev/null
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
systemctl list-timers macro-health.timer --no-pager | head -3
