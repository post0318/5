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
# 한국 감가상각 적재 규칙 판본(scripts/populate-kr-da.mjs KR_DA_RULES_VERSION) — 바뀐 배포면 아래에서 적재를 1회 돌린다
krda_ver() { grep -o 'KR_DA_RULES_VERSION = "[^"]*"' "$J/scripts/populate-kr-da.mjs" 2>/dev/null || true; }
OLD_KRDA=$(krda_ver)
# 재무 엔진판(src/lib/fin/store.ts ENGINE_VERSION) — 바뀐 배포면 fin-build 가 끝난 뒤 ttm-build(재무 저장본이 옛 판인 동안 TTM 은 저장되지 않는다)
engine_ver() { grep -o 'export const ENGINE_VERSION = [0-9]*' "$J/src/lib/fin/store.ts" 2>/dev/null || true; }
OLD_ENGINE=$(engine_ver)
git -C "$J" fetch -q origin "$SHA"
git -C "$J" checkout -q --force "$SHA"
NEW_LOCK=$(sha1sum "$J/package-lock.json" | cut -c1-40)
if [ ! -d "$J/node_modules" ] || [ "$OLD_LOCK" != "$NEW_LOCK" ]; then
  echo "의존성 설치(package-lock 변경)"
  docker run --rm -v "$J":/app -w /app node:24 npm ci --omit=dev --no-audit --no-fund --loglevel=error
fi
sudo chown -R ubuntu:ubuntu "$J"
# 배치 실행기도 저장소 것으로 맞춘다
for f in run-ts.sh run-precompute.sh run-script.sh run-research.sh run-kr-da.sh call-cron.sh alert-lib.sh healthcheck.sh config-backup.sh build-jobs-env.sh research-freshness.sh usage-report.sh; do sudo install -m 755 "$J/ops/oracle/$f" "/opt/macro/ops/$f"; done
bash "$J/ops/oracle/build-jobs-env.sh"
sudo systemctl restart macro-telegram-listener 2>/dev/null || true
# 무효 저장본만 채우기 — 배포를 붙잡지 않게 뒤에서. 엔진판이 바뀐 배포면 순서를 묶는다(fin-build → ttm-build, 둘 다 oneshot 이라 start 가 끝날 때까지 기다림)
NEW_ENGINE=$(engine_ver)
if [ -n "$NEW_ENGINE" ] && [ "$NEW_ENGINE" != "$OLD_ENGINE" ]; then
  echo "재무 엔진판 변경(${OLD_ENGINE:-없음} → $NEW_ENGINE) — fin-build 뒤 ttm-build"
  sudo systemd-run --no-block --unit="post-deploy-fin-$(date +%s)" bash -c 'systemctl start fin-fin-build.service; systemctl start fin-ttm-build.service' 2>/dev/null || true
else
  sudo systemctl start --no-block fin-ttm-build.service 2>/dev/null || true
fi
# 적재 규칙 판본이 바뀐 배포면 감가상각 적재 1회(새 규칙으로 운영 kr_da 다시 채움 — 판본이 다른 적재본은 증분 모드에서도 다시 처리). 타이머가 설치된
# 서버만(설치는 master 병합 뒤 install-schedules.sh — 옛 코드가 운영 kr_da 를 덮지 않게)
NEW_KRDA=$(krda_ver)
if [ -n "$NEW_KRDA" ] && [ "$NEW_KRDA" != "$OLD_KRDA" ] && systemctl list-unit-files fin-kr-da.service >/dev/null 2>&1 && [ -f /etc/systemd/system/fin-kr-da.service ]; then
  echo "감가상각 적재 규칙 판본 변경(${OLD_KRDA:-없음} → $NEW_KRDA) — fin-kr-da 1회"
  sudo systemctl start --no-block fin-kr-da.service || true
fi
echo "작업 폴더 $(git -C "$J" log --oneline -1)"
