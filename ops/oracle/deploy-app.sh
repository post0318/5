#!/usr/bin/env bash
# 1호기 앱 빌드·재시작(deploy-entry.sh 의 deploy 명령이 실행 — 원래 deploy-oracle.yml 안에 있던 내용, 2026-10-06 이전).
# 비밀값은 서버의 /opt/macro/app.env 가 원본이다(GitHub 는 더 이상 쓰지 않는다). 키 교체 절차는 DEPLOY.md §0 "운영 비밀값".
# 손으로 같은 커밋 재기동(키 교체 뒤 등): bash /opt/macro/src/ops/oracle/deploy-app.sh "$(git -C /opt/macro/src rev-parse HEAD)"
# 사용: deploy-app.sh <커밋>
set -euo pipefail
SHA="$1"
ENVF=/opt/macro/app.env
PK=$(grep -E '^NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=' "$ENVF" | cut -d= -f2-)  # 공개 키(브라우저에 실리는 값) — 빌드 때 필요
cd /opt/macro/src
git fetch --quiet origin "$SHA"
git checkout --quiet --force "$SHA"
docker build --progress=plain \
  --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="$PK" \
  --build-arg APP_COMMIT_SHA="$SHA" \
  -t "macro:$SHA" .
sudo install -d -m 755 /opt/macro/sec-cache  # SEC 원본·갱신형 캐시 — 배포해도 남고 배치(run-ts.sh)와 같이 쓴다
sudo install -d -m 755 /opt/macro/dart-cache  # DART 디스크 캐시(판본 = 보고서 최신 접수번호, src/lib/markets/kr/dart-cache.ts) — 배치와 같이 쓴다
docker rm -f macro >/dev/null 2>&1 || true
docker run -d --name macro --restart unless-stopped \
  -p 127.0.0.1:8080:8080 --env-file "$ENVF" \
  -v /opt/macro/sec-cache:/tmp/.cache \
  -v /opt/macro/dart-cache:/dart-cache \
  --memory 3g "macro:$SHA" >/dev/null
# 앱 이미지는 지금 것 + 직전 2개만 남긴다(배치·수집기가 쓰는 node 이미지는 지우지 않게 macro:* 만 정리)
docker images macro --format '{{.Tag}} {{.CreatedAt}}' | sort -k2 -r | awk 'NR>3 {print $1}' | while read -r t; do docker rmi "macro:$t" >/dev/null 2>&1 || true; done
docker builder prune -af --max-used-space 4gb >/dev/null || true  # 빌드 캐시 상한 4GB(Docker 29 옵션 — 지금 빌드가 쓰는 캐시는 남는다, 2026-10-03)
ok=0
for i in $(seq 1 30); do
  if curl -fsS -o /dev/null http://127.0.0.1:8080/api/auth/me; then echo "기동 확인"; ok=1; break; fi
  sleep 2
done
if [ "$ok" != 1 ]; then echo "기동 확인 실패"; docker logs --tail 50 macro; exit 1; fi
# 배치·수집기 작업 폴더를 같은 커밋으로, jobs.env 다시 만들기, 텔레그램 수신기 재시작, TTM 무효 저장본만 채우기
bash /opt/macro/src/ops/oracle/post-deploy.sh "$SHA"
