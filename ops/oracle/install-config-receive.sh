#!/usr/bin/env bash
# 2호기 설정 백업 수신 설치 — 전용 계정 macrobak(비밀번호 없음) + /var/backups/macro-config(700) + 수신 강제 명령.
# 개발 PC 에서:
#   scp -i ~/.ssh/oracle_verify ops/oracle/{macro-config-receive,install-config-receive.sh} ubuntu@140.83.48.57:/tmp/hc/
#   ssh -i ~/.ssh/oracle_verify ubuntu@140.83.48.57 'sudo bash /tmp/hc/install-config-receive.sh "<1호기 backup_ed25519.pub 내용>"'
# 이 키는 1호기 IP 에서, macro-config-receive 실행만 가능(포워딩·터미널 없음). 2호기 → 1호기 접속 권한은 만들지 않는다.
set -euo pipefail
SRC="$(dirname "$(readlink -f "$0")")"
id macrobak >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/macrobak --shell /bin/bash macrobak
passwd -l macrobak >/dev/null
install -m 755 "$SRC/macro-config-receive" /usr/local/bin/macro-config-receive
install -d -m 700 -o macrobak -g macrobak /var/backups/macro-config
if [ -n "${1:-}" ]; then
  install -d -m 700 -o macrobak -g macrobak /var/lib/macrobak/.ssh
  echo "from=\"161.33.9.115\",command=\"/usr/local/bin/macro-config-receive\",restrict $1" > /var/lib/macrobak/.ssh/authorized_keys
  chown macrobak:macrobak /var/lib/macrobak/.ssh/authorized_keys
  chmod 600 /var/lib/macrobak/.ssh/authorized_keys
fi
ls -la /var/backups/macro-config | head -3
