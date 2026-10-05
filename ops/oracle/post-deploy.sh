#!/usr/bin/env bash
# 앱 배포 직후(deploy-oracle.yml) 오라클 서버에서 돈다 — 배치·수집기 작업 폴더를 같은 커밋으로 맞추고, 상주 수신기를 다시 띄우고,
# TTM 저장본 중 무효인 것만 채운다(계산 판번호가 안 바뀐 배포면 거의 할 일이 없다).
# 배치 환경변수 jobs.env 도 여기서 app.env + jobs.local.env 로 다시 만든다(build-jobs-env.sh, 2026-10-06).
# 사용: post-deploy.sh <커밋>
set -euo pipefail
SHA="$1"
# 앱 배포(deploy-oracle)와 작업 폴더 동기화(oracle-sync-jobs)가 같은 푸시에서 동시에 돌 수 있다 — 한 번에 하나만
exec 9>/tmp/macro-jobs.lock
flock 9
J=/opt/macro/jobs
[ -d "$J/.git" ] || git clone -q https://github.com/post0318/5.git "$J"
OLD_LOCK=$(sha1sum "$J/package-lock.json" 2>/dev/null | cut -c1-40 || true)
git -C "$J" fetch -q origin "$SHA"
git -C "$J" checkout -q --force "$SHA"
NEW_LOCK=$(sha1sum "$J/package-lock.json" | cut -c1-40)
if [ ! -d "$J/node_modules" ] || [ "$OLD_LOCK" != "$NEW_LOCK" ]; then
  echo "의존성 설치(package-lock 변경)"
  docker run --rm -v "$J":/app -w /app node:24 npm ci --omit=dev --no-audit --no-fund --loglevel=error
fi
sudo chown -R ubuntu:ubuntu "$J"
# 배치 실행기도 저장소 것으로 맞춘다
for f in run-ts.sh run-script.sh run-research.sh call-cron.sh alert-lib.sh healthcheck.sh config-backup.sh build-jobs-env.sh; do sudo install -m 755 "$J/ops/oracle/$f" "/opt/macro/ops/$f"; done
bash "$J/ops/oracle/build-jobs-env.sh"
sudo systemctl restart macro-telegram-listener 2>/dev/null || true
# 무효 저장본만 채우기 — 배포를 붙잡지 않게 뒤에서
sudo systemctl start --no-block fin-ttm-build.service 2>/dev/null || true
echo "작업 폴더 $(git -C "$J" log --oneline -1)"
