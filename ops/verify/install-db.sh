#!/usr/bin/env bash
# 2호기 검증 DB 매일 복사 타이머 설치(멱등). MongoDB 설치·사용자·/etc/macro-db/*.env 는 이미 있다는 전제(수동 1회).
#   sudo bash ops/verify/install-db.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
install -m 755 "$here/db-sync.sh" /usr/local/bin/macro-db-sync
install -m 755 "$here/db-check.sh" /usr/local/bin/macro-db-check
cat >/etc/systemd/system/macro-db-sync.service <<'EOF'
[Unit]
Description=운영 Atlas → 2호기 검증 DB 한 방향 복사(운영은 읽기만)
After=network-online.target mongod.service
Requires=mongod.service
[Service]
Type=oneshot
ExecStart=/usr/local/bin/macro-db-sync
Nice=10
TimeoutStartSec=1800
EOF
cat >/etc/systemd/system/macro-db-sync.timer <<'EOF'
[Unit]
Description=검증 DB 매일 복사(05:30 KST)
[Timer]
OnCalendar=*-*-* 05:30:00 Asia/Seoul
Persistent=true
RandomizedDelaySec=120
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now macro-db-sync.timer
systemctl list-timers macro-db-sync.timer --no-pager
