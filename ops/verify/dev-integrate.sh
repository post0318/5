#!/usr/bin/env bash
# 2호기 개발 서버(verify-dev, 127.0.0.1:3000) 판 만들기 — 오너 결정 2026-10-16 「섞자」
#   평소·자동 검증 = 일회용 통합본: origin/master 위에 kr/app·jp/app·us/app 을 차례로 병합(커밋은 이 폴더에만, push 하지 않음)
#   배포 승인 직전 검증 = 그 시장 브랜치 그대로:  dev-integrate.sh us/app
# 통합본에서 고칠 것이 보이면 반드시 각 시장 브랜치에서 고친다(이 폴더에서 커밋·수정 금지 — 다음 실행 때 지워진다).
# 시장 브랜치끼리 충돌하면 통합하지 않고 끝낸다(종료코드 2) — 그 시장 브랜치에 master·다른 시장을 맞춘 뒤 다시.
# 결과 판 = $DIR/.dev-build.json(모드·HEAD·브랜치별 커밋). 검증 결과는 이 파일을 함께 기록한다(auto-verify.mjs).
# 다른 판으로 바꾸는 동안 검증이 돌지 않게 /tmp/macro-dev-build.lock 을 잡는다(자동 검증은 실행 내내 이 잠금을 잡고 DEV_BUILD_LOCKED=1 로 부른다).
set -euo pipefail
DIR=${DEV_DIR:-/home/ubuntu/wt-dev}
LOCK=/tmp/macro-dev-build.lock
if [ "${DEV_BUILD_LOCKED:-0}" != 1 ]; then exec 9>"$LOCK"; flock -w 1800 9 || { echo "개발 서버 판 잠금을 30분 안에 못 얻음(검증 중)" >&2; exit 1; }; fi

cd "$DIR"
git fetch -q --prune origin
git reset -q --hard
git clean -qfd -e .env.local -e node_modules -e .next
if [ $# -ge 1 ]; then
  MODE=single
  git checkout -q --detach "origin/$1"
  BRANCHES=("$1")
else
  MODE=integration
  git checkout -q --detach origin/master
  BRANCHES=(kr/app jp/app us/app)
  for b in "${BRANCHES[@]}"; do
    if ! git -c user.name=dev-integrate -c user.email=dev-integrate@localhost merge -q --no-edit "origin/$b" >/dev/null; then
      echo "통합 충돌: $b — $(git diff --name-only --diff-filter=U | tr '\n' ' ')" >&2
      git merge --abort
      exit 2
    fi
  done
fi

# 의존성 — package-lock.json 이 바뀌었을 때만 설치(같은 작업을 두 번째 돌릴 때 외부 요청 0)
LH=$(sha256sum package-lock.json | cut -c1-16)
if [ ! -f node_modules/.lockhash ] || [ "$(cat node_modules/.lockhash)" != "$LH" ]; then
  npm ci --no-audit --no-fund >/dev/null
  echo "$LH" > node_modules/.lockhash
fi

{
  printf '{"mode":"%s","head":"%s","at":"%s","branches":{' "$MODE" "$(git rev-parse HEAD)" "$(date -Is)"
  sep=""
  [ "$MODE" = integration ] && { printf '"master":"%s"' "$(git rev-parse origin/master)"; sep=","; }
  for b in "${BRANCHES[@]}"; do printf '%s"%s":"%s"' "$sep" "$b" "$(git rev-parse "origin/$b")"; sep=","; done
  printf '}}\n'
} > .dev-build.json.tmp && mv .dev-build.json.tmp .dev-build.json

sudo systemctl restart verify-dev
for i in $(seq 1 60); do
  c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 http://localhost:3000/ || true)
  if [ -n "$c" ] && [ "$c" != 000 ] && [ "$c" -lt 500 ]; then echo "개발 서버 판: $(cat .dev-build.json)"; exit 0; fi
  sleep 5
done
echo "개발 서버가 5분 안에 뜨지 않음 — journalctl -u verify-dev" >&2
exit 1
