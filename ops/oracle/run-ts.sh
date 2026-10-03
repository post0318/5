#!/usr/bin/env bash
# 앱 계산 코드를 쓰는 배치(scripts/run/*.mts — fin-build·ttm-build)를 오라클 서버에서 실행한다(2026-10-03 — 예전엔 GitHub 실행 서버).
# 작업 폴더(/opt/macro/jobs)는 배포 때 운영 앱과 같은 커밋으로 맞춰지므로 계산 엔진판이 운영과 같다.
# SEC 원본·갱신형 캐시는 /opt/macro/sec-cache 에 두어 실행 사이에 남긴다(새 공시분만 받는다).
# 사용: run-ts.sh <scripts/run 아래 파일> [인자...]   예) run-ts.sh ttm-build.mts --minutes=100
set -uo pipefail
SHA=$(git -C /opt/macro/jobs rev-parse HEAD)
install -d -m 755 /opt/macro/sec-cache /opt/macro/npm-cache
exec docker run --rm --network host --env-file /opt/macro/jobs.env \
  -e APP_COMMIT_SHA="$SHA" -e NODE_OPTIONS=--conditions=react-server -e SEC_CACHE_DIR=/sec-cache -e npm_config_cache=/npm-cache \
  -v /opt/macro/jobs:/app -v /opt/macro/sec-cache:/sec-cache -v /opt/macro/npm-cache:/npm-cache -w /app \
  --memory 3g --cpus 1.5 node:24-slim npx -y tsx@4.23.15 --tsconfig tsconfig.json "scripts/run/$1" "${@:2}"
