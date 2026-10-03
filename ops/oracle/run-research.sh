#!/usr/bin/env bash
# 국내 리서치 수집(하루 6회 08·10·12·14·16·18시) — 목적은 "그사이 새 글이 나왔는지" 확인(오너 2026-10-03).
# 08시 회차만 수집기 기본 범위(3~14일)로 넓게 훑고, 나머지 회차는 최근 1일만 본다(--days=1). 이미 받은 리포트의 PDF 는
# 디스크 캐시라 다시 내려받지 않는다. 사용: run-research.sh <스크립트>
set -uo pipefail
H=$(TZ=Asia/Seoul date +%H)
if [ "$H" -lt 10 ]; then exec /opt/macro/ops/run-script.sh "$1"; fi
exec /opt/macro/ops/run-script.sh "$1" --days=1
