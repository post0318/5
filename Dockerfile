# 구글 Cloud Run·오라클 서버용 컨테이너(2026-10-03). Vercel 배포와 무관 — GitHub Actions 가 빌드한다.
# 오라클은 서버에서 직접 빌드한다(ARM, .github/workflows/deploy-oracle.yml).
# 빌드: docker build --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=... --build-arg APP_COMMIT_SHA=$(git rev-parse HEAD) -t app .
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# 오라클(ARM) 서버는 bufferutil·utf-8-validate 의 미리 빌드된 파일이 없어 설치 때 컴파일한다(2026-10-03 실측). 이 단계는 최종 이미지에 안 들어간다.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/* \
    && npm ci --no-audit --no-fund

FROM node:24-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 브라우저 코드에 박히는 공개 값은 빌드 때 필요
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV BUILD_STANDALONE=1 NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:24-slim AS run
WORKDIR /app
ARG APP_COMMIT_SHA=local
ENV NODE_ENV=production PORT=8080 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1 \
    APP_COMMIT_SHA=$APP_COMMIT_SHA SEC_CACHE_DIR=/tmp/.cache
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 8080
CMD ["node", "server.js"]
