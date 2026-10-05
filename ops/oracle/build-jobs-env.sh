#!/usr/bin/env bash
# 배치·수집기 환경변수 파일(/opt/macro/jobs.env)을 서버 안에서 만든다(2026-10-06 — 예전엔 손 관리).
#   jobs.env = app.env(앱 컨테이너 전용 줄 제외) + jobs.local.env(배치 전용 값 — TELEGRAM_* 등, 같은 이름이면 이쪽이 이긴다)
# 원본은 app.env·jobs.local.env 둘 다 서버에만 있다(600). 값은 출력하지 않는다. post-deploy.sh 가 매번 부른다.
set -euo pipefail
A=/opt/macro/app.env
L=/opt/macro/jobs.local.env
O=/opt/macro/jobs.env
[ -f "$A" ] || { echo "app.env 없음 — jobs.env 그대로 둠"; exit 0; }
umask 077
T=$(mktemp /opt/macro/.jobs.env.XXXXXX)
trap 'rm -f "$T"' EXIT
# 앱 컨테이너 전용(배치 실행기 run-ts.sh 가 -e 로 따로 준다): APP_COMMIT_SHA·SEC_CACHE_DIR·DART_CACHE_DIR
awk -F= -v lf="$L" '
  BEGIN { while ((getline line < lf) > 0) { split(line, p, "="); if (p[1] ~ /^[A-Za-z_][A-Za-z0-9_]*$/) own[p[1]] = 1 } }
  $1 ~ /^[A-Za-z_][A-Za-z0-9_]*$/ && $1 !~ /^(APP_COMMIT_SHA|SEC_CACHE_DIR|DART_CACHE_DIR)$/ && !($1 in own) { print }
' "$A" > "$T"
[ -f "$L" ] && grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$L" >> "$T"
if cmp -s "$T" "$O"; then echo "jobs.env 변경 없음($(wc -l < "$T")줄)"; exit 0; fi
[ "$(id -u)" = 0 ] && chown --reference="$A" "$T"
mv "$T" "$O"
trap - EXIT
echo "jobs.env 갱신($(wc -l < "$O")줄)"
