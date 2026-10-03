#!/usr/bin/env bash
# 수집 스크립트(scripts/*.mjs)를 오라클 서버에서 실행한다 — 작업 폴더(/opt/macro/jobs, 배포 때 운영 앱과 같은 커밋 + 의존성 설치됨)를
# node 컨테이너로 돌린다. 전송은 서버 안 앱으로 바로(APP_URL=http://127.0.0.1:8080), 비밀값은 /opt/macro/app.env.
# 리서치 PDF 텍스트는 /opt/macro/research-cache 에 남겨 다음 회차에 다시 받지 않는다(scripts/lib/research-extract.mjs).
# 사용: run-script.sh <스크립트> [인자...]
set -uo pipefail
install -d -m 755 /opt/macro/research-cache
exec docker run --rm --network host --env-file /opt/macro/app.env -e APP_URL=http://127.0.0.1:8080 \
  -e RESEARCH_PDF_CACHE_DIR=/research-cache -v /opt/macro/research-cache:/research-cache \
  -v /opt/macro/jobs:/app:ro -w /app --memory 1g --cpus 1 node:24-slim node "scripts/$1" "${@:2}"
