#!/usr/bin/env bash
# 한국 감가상각 적재(scripts/populate-kr-da.mjs)를 운영 1호기에서 운영 컬렉션 kr_da 로 실행한다(2026-10-05 오너 결정 — "검증 쪽은 운영 DB 에 쓰지 않는다,
# 운영 반영은 master 병합 후 운영 1호기가 직접"). 기본은 증분(정기공시 최신 접수번호·적재 규칙 판본이 그대로인 종목은 list.json 1건만 보고 건너뜀).
# 비밀값(MONGODB_URI·DART_API_KEY)은 /opt/macro/jobs.env, 운영 컬렉션 허용은 이 실행기만(KR_DA_ALLOW_PROD=1 — 개발 폴더·2호기에서는 거부).
# DART 하루 상한(적재 2,000건)·020 즉시 중단 — 카운터는 /opt/macro/dart-quota(운영 화면 몫이 남게).
# DART 원문 디스크 캐시는 앱과 같은 /opt/macro/dart-cache(같은 배치·판본 규칙 — 접수번호 판본, scripts/lib/dart-disk-cache.mjs) — 적재 규칙만 바뀐
# 재처리는 디스크에서 다시 계산만 하고 DART 요청은 종목당 정기공시 목록 1건.
# 사용: run-kr-da.sh [--full] [종목...]
set -uo pipefail
install -d -m 755 /opt/macro/dart-quota /opt/macro/dart-cache
exec docker run --rm --network host --env-file /opt/macro/jobs.env \
  -e KR_DA_COLLECTION=kr_da -e KR_DA_ALLOW_PROD=1 -e DART_QUOTA_DIR=/dart-quota -e DART_CACHE_DIR=/dart-cache \
  -v /opt/macro/jobs:/app:ro -v /opt/macro/dart-quota:/dart-quota -v /opt/macro/dart-cache:/dart-cache -w /app \
  --memory 1g --cpus 1 node:24-slim node scripts/populate-kr-da.mjs "$@"
