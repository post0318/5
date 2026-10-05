#!/usr/bin/env bash
# 2호기(macro-verify) 점검(healthcheck-peer.sh)을 10분마다 돌리는 systemd 타이머를 설치하고, 1호기가 하트비트를 읽을 전용 키를 등록한다.
# 2호기에는 master 작업 폴더가 없으므로 개발 PC 에서 파일을 올려 실행한다(DEPLOY.md "상호 감시"):
#   scp -i ~/.ssh/oracle_verify ops/oracle/{alert-lib.sh,healthcheck-peer.sh,install-health-peer.sh} ubuntu@140.83.48.57:/tmp/
#   ssh -i ~/.ssh/oracle_verify ubuntu@140.83.48.57 'sudo bash /tmp/install-health-peer.sh "<1호기 peer_ed25519.pub 내용>"'
# 공개키 인자는 생략 가능(이미 등록돼 있으면 그대로). 다시 돌려도 같은 결과.
set -euo pipefail
SRC="$(dirname "$(readlink -f "$0")")"
install -d -m 755 /opt/macro-health
install -m 644 "$SRC/alert-lib.sh" /opt/macro-health/alert-lib.sh
install -m 755 "$SRC/healthcheck-peer.sh" /opt/macro-health/healthcheck-peer.sh
[ -f /opt/macro-health/alert.env ] || install -m 600 /dev/null /opt/macro-health/alert.env
install -d -m 755 /var/lib/macro-health

cat > /etc/systemd/system/macro-peer-health.service <<'EOF'
[Unit]
Description=2호기 점검 + 1호기(운영) 감시
After=network-online.target

[Service]
Type=oneshot
ExecStart=/opt/macro-health/healthcheck-peer.sh
Nice=10
EOF

cat > /etc/systemd/system/macro-peer-health.timer <<'EOF'
[Unit]
Description=2호기 점검 10분마다

[Timer]
OnBootSec=3min
OnUnitActiveSec=10min
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now macro-peer-health.timer

# 1호기 전용 키 — 하트비트 출력 강제 명령만, 1호기 IP 에서만, 포워딩·터미널 없음(restrict)
if [ -n "${1:-}" ]; then
  AK=/home/ubuntu/.ssh/authorized_keys
  sed -i '/macro-peer-heartbeat$/d' "$AK"
  [ -s "$AK" ] && [ -n "$(tail -c1 "$AK")" ] && echo >> "$AK"   # 마지막 줄에 줄바꿈이 없으면 기존 키 줄에 붙지 않게
  echo "from=\"161.33.9.115\",command=\"cat /var/lib/macro-health/heartbeat\",restrict $1" >> "$AK"
  chown ubuntu:ubuntu "$AK"
  chmod 600 "$AK"
fi
systemctl list-timers macro-peer-health.timer --no-pager | head -3
