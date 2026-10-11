---
name: project-dart-shared-key-limit
description: 검증 서버와 운영이 같은 DART 키 — 검증이 일일 한도(020)를 넘기면 운영 한국 재무 화면이 통째로 멈춘다(2026-10-05 실제 발생)
metadata:
  type: project
---

2026-10-05 저녁, 한국 감사 수정 작업(30종목 `populate-kr-da.mjs --check` 원문 대량 다운로드 + 하루 여러 번 전체 검증)이 OpenDART 일일 한도를 넘겨(020) **운영 한국 재무가 멈췄다** — `/api/markets/kr/005930/financials` 429 "OpenDART 사용 한도를 초과했습니다", 하이라이트 null, TTM null. 검증 서버(140.83.48.57)와 운영(161.33.9.115)이 같은 DART 키를 쓰기 때문(오너 — "아이디 관리 복잡해지는 건 싫다").

**Why:** IP 분리만으로는 한도가 분리되지 않는다. 한도는 키 단위.

**How to apply:** 한국 검증·적재 작업 전에 하루 DART 요청 예산을 정하고(예: 검증 쪽 상한), 원문 대량 다운로드(--check 전 종목)는 하루 한 번 이하로. 한도 초과 시 운영 영향부터 확인해 오너에게 보고. 관련: [[project-hosting-no-billing]] [[project-kr-audit2-resume]]

**키 분리 현황(2026-10-05 저녁)**: DART — 오너가 새 키 발급, 검증 서버(2호기 `~/5/.env.local`)·로컬 `.env.local` = 검증 전용 새 키, 운영 = 기존 키(GitHub 비밀값). 한국은행 ECOS — 오너가 "서버용" 새 키 발급 → GitHub 비밀값 교체·오라클/Cloud Run 재배포로 운영 전용, 검증 서버·로컬 = 기존 키. 2호기에는 IPO 수요예측 서비스(ipo@prod/dev, `/etc/ipo/*.env` IPO_DART_API_KEY)가 같이 돌며 운영 DART 키를 공유 중 — 오너 결정(10-05): IPO 운영용(ipo@prod, /etc/ipo/prod.env)은 운영 DART 키, IPO 개발용(ipo@dev, dev.env)은 검증 DART 키(10-05 적용, 백업 dev.env.bak-20261005). 검증·적재도 검증 키. 공공데이터포털 — 오너가 검증용 새 키 발급(10-05), 2호기·로컬 = 새 키(배당·권리일정 활용 승인, 주식시세·지수시세는 "등록되지 않은 서비스" — 활용신청·동기화 확인 필요), 운영 = 기존 키. KRX·네이버·Gemini·MongoDB 는 아직 운영과 2호기가 같은 키.
