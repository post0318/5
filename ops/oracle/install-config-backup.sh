#!/usr/bin/env bash
# 1호기 설정 백업(config-backup.sh) 설치 — age 설치, 암호화 키·전송 키 생성(없을 때만), 매일 05:40 KST 타이머.
# 사용: sudo bash /opt/macro/jobs/ops/oracle/install-config-backup.sh   (다시 돌려도 같은 결과, 키는 덮어쓰지 않음)
# 끝나면 2호기에 등록할 전송 공개키를 출력한다 → 2호기 install-config-receive.sh 인자로(DEPLOY.md "설정 백업").
# 복호화 키 /opt/macro/ops/config-backup.key 는 개발 PC C:\Users\post0\.ssh\macro-config-backup.key 로 한 번 복사해 둔다(내용 출력 금지).
set -euo pipefail
OPS=/opt/macro/ops
PEER_HOST="${OPS_PEER_HOST:-140.83.48.57}"
command -v age >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -q age >/dev/null
command -v rsync >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -q rsync >/dev/null
install -m 755 "$(dirname "$(readlink -f "$0")")/config-backup.sh" "$OPS/config-backup.sh"

umask 077
[ -f "$OPS/config-backup.key" ] || age-keygen -o "$OPS/config-backup.key" 2>/dev/null
age-keygen -y "$OPS/config-backup.key" > "$OPS/config-backup.pub"
chmod 600 "$OPS/config-backup.key"; chmod 644 "$OPS/config-backup.pub"
[ -f "$OPS/backup_ed25519" ] || ssh-keygen -q -t ed25519 -N "" -C macro-config-backup -f "$OPS/backup_ed25519"
[ -s "$OPS/peer_known_hosts" ] || ssh-keyscan -t ed25519 "$PEER_HOST" > "$OPS/peer_known_hosts" 2>/dev/null
umask 022

cat > /etc/systemd/system/macro-config-backup.service <<'EOF'
[Unit]
Description=1호기 설정 백업(암호화 → 2호기)
After=network-online.target

[Service]
Type=oneshot
ExecStart=/opt/macro/ops/config-backup.sh
Nice=10
EOF

cat > /etc/systemd/system/macro-config-backup.timer <<'EOF'
[Unit]
Description=1호기 설정 백업 매일 05:40 KST

[Timer]
OnCalendar=*-*-* 05:40:00 Asia/Seoul
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now macro-config-backup.timer
echo "2호기에 등록할 전송 공개키: $(cat "$OPS/backup_ed25519.pub")"
systemctl list-timers macro-config-backup.timer --no-pager | head -3
