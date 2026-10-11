---
name: feedback-verify-no-prod-writes
description: 2호기 검증 서버(앱 포함)는 운영 DB 에 절대 저장하지 않는다 — 운영 반영은 개발 완료 후 master 병합 때만
metadata:
  type: feedback
---

2호기 검증 서버는 운영과 같은 앱을 띄우더라도 운영 DB(Atlas market_research)에 저장하면 안 된다. 바뀐 계산·적재 결과가 운영에 들어가는 것은 개발이 끝나 master 에 병합·배포될 때뿐이다.

**Why:** 오너 지시 2026-10-05 — "2호기 검증 서버의 앱 자체를 똑같이 구성한다고 해도 운용 DB 에 저장하면 안 된다. 개발이 완료되고 병합할 때 반영되어야 하는 코딩이다." 전수조사에서 verify-dev(검증 브랜치, master 보다 91커밋 앞섬)가 fin_sym·ttm_snap·api_snap 등을 운영 DB 에 쓰고 있었음이 드러남.

**How to apply:** 검증 서버·검증 스크립트·로컬 개발의 DB 주소는 2호기 자체 DB(운영 DB 매일 복사본). 운영 DB 쓰기는 명시적 운영 경로(배포된 운영 앱, `--prod` 같은 명시 옵션)만. 2호기 DB 가 생기기 전 임시로 verify-dev 에 FIN_NO_PERSIST=1. 관련: [[project-dart-shared-key-limit]] [[project-hosting-no-billing]]
