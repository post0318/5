#!/usr/bin/env bash
# 1호기 설정 백업(2026-10-05, 오너 지시 — "설정 백업 보관소도 2호기에 추가한다").
# GitHub 에 없는 1호기 설정을 묶어 **1호기에서 age 로 암호화**한 뒤 2호기에 보낸다. 2호기에는 암호문만 남는다.
# systemd 타이머(macro-config-backup.timer, 매일 05:40 KST)가 root 로 실행. 설치는 install-config-backup.sh.
#
# 담는 것: /opt/macro/{jobs.env,app.env}, /opt/macro/ops(복호화 키 제외), /etc/caddy/Caddyfile, /etc/iptables,
#   /etc/systemd/system 의 프로젝트 유닛(macro-*·news-*·research-*·fin-*·weekly-*·measure-*), 유닛 목록·활성 상태, crontab,
#   MANIFEST.sha256(원본 파일별 해시 — 복원 대조용). 캐시(sec-cache·dart-cache·research-cache·npm-cache)·저장소 사본(jobs·src)은 제외.
# 암호화: 수신자 공개키 /opt/macro/ops/config-backup.pub. 복호화 키는 1호기 /opt/macro/ops/config-backup.key(root 600)와
#   개발 PC C:\Users\post0\.ssh\macro-config-backup.key 에만 있다.
# 전송: 전용 키 /opt/macro/ops/backup_ed25519 → 2호기 macrobak 계정. 그쪽 authorized_keys 가 이 키를
#   macro-config-receive(표준입력을 날짜 이름으로 저장만) 강제 명령으로 제한한다.
# 성공하면 /var/lib/macro-health/.config-backup-ok 를 갱신 — healthcheck.sh 가 26시간 넘게 안 바뀌면 알린다.
set -euo pipefail
OPS=/opt/macro/ops
PEER_HOST="${OPS_PEER_HOST:-140.83.48.57}"
STAMP=/var/lib/macro-health/.config-backup-ok
UNIT_RE='^(macro|news|research|fin|weekly|measure)-'

W=$(mktemp -d /dev/shm/macro-config.XXXXXX)
trap 'rm -rf "$W"' EXIT
chmod 700 "$W"
S="$W/stage"
mkdir -p "$S/meta" "$S/etc/systemd/system"

cp -a --parents /opt/macro/jobs.env /opt/macro/app.env /etc/caddy/Caddyfile "$S"/
[ -d /etc/iptables ] && cp -a --parents /etc/iptables "$S"/
rsync -a --exclude 'config-backup.key' "$OPS/" "$S/opt/macro/ops/"
for u in /etc/systemd/system/*; do
  basename "$u" | grep -Eq "$UNIT_RE" && cp -a "$u" "$S/etc/systemd/system/"
done
systemctl list-unit-files --no-legend --no-pager | awk '{print $1, $2}' | grep -E "$UNIT_RE" > "$S/meta/unit-files.txt" || true
systemctl list-timers --all --no-legend --no-pager > "$S/meta/timers.txt" || true
{ echo "# root"; crontab -l -u root 2>&1 || true; echo "# ubuntu"; crontab -l -u ubuntu 2>&1 || true; } > "$S/meta/crontab.txt"
echo "$(date -Is) $(hostname) $(git -C /opt/macro/jobs log --oneline -1 2>/dev/null)" > "$S/meta/created.txt"
(cd "$S" && find . -type f ! -path ./MANIFEST.sha256 -print0 | sort -z | xargs -0 sha256sum) > "$S/MANIFEST.sha256"

tar -C "$S" -czf - . | age -R "$OPS/config-backup.pub" -o "$W/backup.age"
SUM=$(sha256sum "$W/backup.age" | cut -d' ' -f1)
REPLY=$(ssh -i "$OPS/backup_ed25519" -o BatchMode=yes -o ConnectTimeout=15 \
  -o UserKnownHostsFile="$OPS/peer_known_hosts" -o StrictHostKeyChecking=yes \
  "macrobak@${PEER_HOST}" < "$W/backup.age")
# 2호기 응답: "saved <파일명> <sha256>"
case "$REPLY" in
  "saved "*" $SUM") touch "$STAMP"; echo "백업 완료: $REPLY ($(du -h "$W/backup.age" | cut -f1))" ;;
  *) echo "백업 실패 — 2호기 응답: $REPLY (보낸 해시 $SUM)" >&2; exit 1 ;;
esac
