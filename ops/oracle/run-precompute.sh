#!/usr/bin/env bash
# 새 유니버스 종목 미리 계산(오너 승인 2026-10-06) — 타이머 fin-precompute(5분마다)가 실행한다. 대기열 precompute_queue 를 읽어
#   ① 미국: run-ts.sh precompute.mts 안에서 재무 조립·TTM 저장(그 종목만, 순서대로, 회차당 10종목)
#   ② 한국: 같은 실행이 꺼낸 종목(KR_CLAIMED)을 run-kr-da.sh <종목…> 로 감가상각 적재(회차당 5·24시간 30종목) → 결과를 대기열에 기록.
#      run-kr-da.sh 가 없거나(한국 검증 master 병합 전) fin-kr-da 가 돌고 있으면 꺼내지 않는다(대기열에 남음).
# 정기 배치(fin-fin-build·fin-ttm-build·fin-kr-da)가 돌고 있으면 이번 회차는 쉰다 — SEC 순차·DART 몫을 겹치지 않게.
# 종료코드: 처리 실패가 최종 실패(재시도 2회 뒤)로 남아 있으면 1(healthcheck job-fin-precompute 알림).
set -uo pipefail
for u in fin-fin-build fin-ttm-build fin-kr-da; do
  if systemctl is-active --quiet "$u.service"; then echo "$u 실행 중 — 이번 회차 건너뜀"; exit 0; fi
done
KR_FLAG=()
if [ -x /opt/macro/ops/run-kr-da.sh ] && grep -q 'KR_DA_RULES_VERSION = "' /opt/macro/jobs/scripts/populate-kr-da.mjs 2>/dev/null; then
  KR_FLAG=(--kr)
fi
out=$(/opt/macro/ops/run-ts.sh precompute.mts "${KR_FLAG[@]}" 2>&1)
rc=$?
echo "$out"
codes=$(printf '%s\n' "$out" | sed -n 's/^KR_CLAIMED: //p' | tail -1)
if [ -n "$codes" ]; then
  kout=$(/opt/macro/ops/run-kr-da.sh ${codes//,/ } 2>&1)
  krc=$?
  echo "$kout"
  if [ "$krc" = 0 ]; then mode=ok; err=""
  elif printf '%s' "$kout" | grep -qE '상한 도달|UsageLimitError'; then mode=defer; err="DART 하루 상한(적재 카운터·사용량 장부)"
  else mode=fail; err=$(printf '%s\n' "$kout" | grep -v '^\s*$' | tail -1 | cut -c1-200)
  fi
  /opt/macro/ops/run-ts.sh precompute.mts --kr-finish="$mode" --codes="$codes" --error="$err" || rc=1  # 최종 실패가 있으면 1
fi
exit "$rc"
