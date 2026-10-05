#!/usr/bin/env bash
# 2호기: 1호기가 검증 결과(/var/lib/macro-verify/latest.json)를 읽어 가는 전용 키 등록(2026-10-06, pull 방식).
# 설정 백업과 같은 전용 계정 macrobak(install-config-receive.sh 가 만든다)에 별도 키 줄로 — 읽기 강제 명령만, 1호기 IP 에서만.
# 개발 PC 에서:
#   scp -i ~/.ssh/oracle_verify ops/oracle/install-verify-share.sh ubuntu@140.83.48.57:/tmp/hc/
#   ssh -i ~/.ssh/oracle_verify ubuntu@140.83.48.57 'sudo bash /tmp/hc/install-verify-share.sh "<1호기 verifypull_ed25519.pub 내용>"'
# latest.json 은 verify-db 작업이 쓴다 — macrobak 이 읽을 수 있어야 한다(파일 644, 폴더 755).
set -euo pipefail
[ -n "${1:-}" ] || { echo "공개키 인자 필요" >&2; exit 1; }
id macrobak >/dev/null 2>&1 || { echo "macrobak 계정 없음 — install-config-receive.sh 먼저" >&2; exit 1; }
AK=/var/lib/macrobak/.ssh/authorized_keys
install -d -m 700 -o macrobak -g macrobak /var/lib/macrobak/.ssh
touch "$AK"
sed -i '/macro-verify-pull$/d' "$AK"
[ -s "$AK" ] && [ -n "$(tail -c1 "$AK")" ] && echo >> "$AK"
echo "from=\"161.33.9.115\",command=\"cat /var/lib/macro-verify/latest.json\",restrict $1" >> "$AK"
chown macrobak:macrobak "$AK"; chmod 600 "$AK"
awk '{print $NF}' "$AK"
