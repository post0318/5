---
name: feedback-verifier-precheck
description: "검증기 수정 후 30종목 전 no-undef 정적 검사 + 대표 1종목, 공유 verify-dev 앱 파일은 flock 잡고 한 번에 덮어쓰기"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 9de48b16-a312-45d9-988a-941732b3bead
  modified: 2026-10-09T23:58:55.997Z
---

검증기(scripts/verify-financials.mjs·scripts/verify-kr/*.mjs)를 고친 뒤 30종목 전체 실행 전에 반드시 no-undef 정적 검사(정의 안 된 변수 0)와 대표 1종목 실행(층별 오류 0)을 먼저 한다. 공유 verify-dev(2호기 :3000)의 앱 파일은 다른 곳에서 고친 뒤 `flock /tmp/macro-verify.lock` 을 잡은 상태에서 한 번에 덮어쓴다.

**Why:** 2026-10-10 한국 LTM 층에 NA·FAIL 상수를 빠뜨려 30종목 한 바퀴(약 30분)가 전부 판독 오류로 버려졌고, opendart.ts 를 제자리에서 고치는 몇 초 동안 개발 서버 전 라우트가 500 이 돼 미국 검증이 막혔다(리드 지시).

**How to apply:** `npx eslint --rule "no-undef: error" scripts/verify-kr/*.mjs scripts/verify-financials.mjs` → 대표 1종목(flock) → 30종목(flock). 앱 파일은 스크래치에서 편집·tsc 확인 후 잠금 아래 복사. 관련: [[feedback-verify-server-memory]]
