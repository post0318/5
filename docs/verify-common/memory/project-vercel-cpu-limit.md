---
name: project-vercel-cpu-limit
description: "Vercel Hobby Active CPU 월 4시간 초과로 2026-10 운영 정지 — 운영 서버 CPU 사용 금지, 검증은 로컬 전용, 앱 코드 푸시는 모아서"
metadata:
  node_type: memory
  type: project
  originSessionId: 01d0db45-f81a-414b-9ed4-6a2233ab4a4a
  modified: 2026-10-02T21:57:38.419Z
---

2026-10-03 운영 사이트(macroresearch.vercel.app)가 HTTP 402 DEPLOYMENT_DISABLED 로 멈췄다. 원인은 Fluid Active CPU 5시간 38분 / Hobby 한도 4시간. 대부분 ttm-build(master 푸시마다 유니버스 미국 전 종목 재조립, 10-01~02 푸시 35회)와 3시간마다 돌던 재무 검증이었다.

**Why:** 오너 지시 2026-10-03 — 운영 서버 CPU 를 쓰지 않는다. 대책은 master CLAUDE.md 에 들어가 있다(`vercel.json` ignoreCommand, ttm-build 경로 트리거, 검증 워크플로 삭제).

**How to apply:** 재무 검증은 로컬 dev 서버 대상으로만 돌린다. 앱 코드(src·public·패키지·설정)를 바꾼 푸시는 모아서 한 번에 한다(푸시 한 번 = 운영 전 종목 재조립 한 번). `kr/verification` 브랜치는 이 규칙이 들어간 master 커밋이 아직 합쳐지지 않았을 수 있으니 브랜치의 CLAUDE.md 에 없더라도 이 규칙을 따른다. 관련: [[project-verification-order]]
