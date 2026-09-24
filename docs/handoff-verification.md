# 재무 검증 작업 인수인계 (2026-09-24 밤)

브랜치: `wip/verification` (master 에 합치면 Vercel 프로덕션 배포 — 오너 지시 전까지 master 푸시 금지)

## 지금까지 된 것
- 검증 스크립트(`scripts/verify-financials.mjs`): A층 SEC 정확 일치, F층 외부 3소스(Yahoo·StockAnalysis·인포맥스),
  국내 FnGuide 대조, 원인 판정은 숫자로 성립할 때만 "원인 확인", 영업이익 본표 존재·LTM 지연 검사.
- 감사(REQUEST CHANGES) 지적 앱 쪽 반영(c395144): COST 운용리스 상각 제외, CVX 유동 판정(계산 구조 위치),
  LLY 종업원 신탁주식·협업매출 오분리(`OtherRevenueMember` 정확 일치)·R&D 태그, DIS 구조 판독 실패 시에도
  부문 영업이익 제거, TTM 판본 선택 통일(`vintageOrder` — 5개 모듈), 분할 이력 필수, 우선주 클래스 제외,
  검증결과 API 입력 검증·CRON_SECRET 전용 쓰기, 워크플로 실패 표시.
- 미국 유니버스 47종목 중 34종목 재검증 실패 0 (+ COST·CVX·LLY·DIS·WMT·XOM 실패 0).

## 남은 일 (순서대로)
1. 미국 나머지 13종목 재검증: `SBUX,SNDK,SPOT,TER,TSLA,TSM,UBER,V,VRT,VST,WDC`
   `node scripts/verify-financials.mjs --symbols=... --concurrency=1` (dev 서버 필요, 병렬은 SEC 429)
2. 독립 재감사 요청(검증 도구 작성자가 스스로 승인하지 않는다 — CLAUDE.md).
3. 한국 FnGuide 불일치 분석: 삼성전자 EBITDA −5~−11%, EV +2~4%, 지배 순이익 1~7% (정의 차이 규명).
   한국 DART 원자료 A층 대조 신설 검토.
4. 미국 외부 미해명 약 104건: LLY 영업이익(취득 IPR&D 3.8B — 외부는 제외, GAAP 본표는 포함), CEG/VST 핵연료 상각,
   MAR/HLT LTM, 합성 영업이익(IBM·XOM·DIS), 운용리스 포함 차입금(정의 차).
5. 유니버스 밖: JPM 2021 영업이익 −185M, JPM EPS 주석, PSA EBITDA 빈칸.
6. CLAUDE.md · `docs/verification-status.md` 에 이번 감사 반영분 기록.

## 다른 PC 준비
- `.env.local` 은 git 에 없다 — 원래 PC 에서 복사해 올 것(`vercel env pull` 은 민감값이 빈칸으로 온다).
- `npm ci` → `npm run dev` → 위 명령.
