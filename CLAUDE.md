# CLAUDE.md

이 파일은 Claude Code가 이 저장소에서 작업할 때 참고하는 가이드입니다.
제품 요구사항 전체는 `prd.md` 참조.

## 프로젝트

유니버스 종목의 재무제표 · 공시 · 뉴스 · 멀티플을 한 화면에서 조회하는
글로벌 종목 리서치 대시보드. 대상 시장: **한국 / 미국 / 일본**.

## 기술 스택

- Next.js (App Router) + TypeScript
- Tailwind CSS + shadcn/ui (다크/라이트 모드)
- TanStack Table (테이블), TanStack Query 또는 Next.js fetch 캐싱
- Recharts (차트)
- Postgres (Neon 등, Vercel Marketplace) — 유니버스 저장
- date-fns (날짜)
- 배포: Vercel

## 명령어

> 프로젝트 스캐폴딩 후 채울 것.

```
# 개발 서버
npm run dev

# 빌드 / 타입체크 / 린트
npm run build
npm run lint
```

## 아키텍처 규칙

- **외부 금융 API 호출은 반드시 서버(Route Handler `app/api/...`)에서만.**
  클라이언트에서 직접 호출 금지 — API 키 은닉, CORS 회피, 캐싱, rate limit 관리.
- 시장별 로직은 어댑터 패턴으로 분리 (`lib/markets/{kr,us,jp}/`).
- 매일 배치 수집 → Postgres 저장, 조회는 DB 우선. Vercel Cron 사용.

### 배포 시나리오 = 개인용 시작, 확장 가능성 (prd.md §4.0)

- **현재 개인용** → 무료 API의 personal/non-commercial 조건 안. L4 포워드 컨센서스도 인앱 허용.
- 모든 외부 소스는 **어댑터 인터페이스 뒤에 격리** → 확장 시 교체가 파일/설정 수준이 되도록.

### 데이터 레이어 (prd.md §4)

| 레이어 | 소스 | 개인용 렌더링 |
|--------|------|--------------|
| L1 공시·재무제표 | 한국 OpenDART / 미국 SEC EDGAR / 일본 EDINET API v2 | 인앱 |
| L2 EOD 시세 | Stooq (주), `yahoo-finance2` (보조). 한국 부족 시 공공데이터포털/KRX 폴백 | 인앱 |
| L3 트레일링 멀티플 | 자체 계산 (L1+L2) | 인앱 |
| L4 포워드 컨센서스 | `yahoo-finance2` `quoteSummary` (개인용) + 딥링크 병행 | 인앱 + 딥링크 |
| L5 뉴스 | `yahoo-finance2` `search` / 규제기관 공시 + 딥링크 | 인앱 목록 + 딥링크 |

- **크롤링은 어떤 시나리오에서도 금지**: FnGuide(`robots.txt Disallow: /`),
  stockanalysis·MarketScreener(ToS) → 딥링크만.
- `yahoo-finance2` / yfinance / Finnhub·FMP·Polygon 무료 = **개인용 한정.**
  팀/대외 확장 시 인앱 중단 → 딥링크 또는 정식 라이선스 (prd.md §4.3).
- L1(공식 API)·L3(자체 계산)은 모든 시나리오에서 안전.

## 숫자 · 통화 포맷 (엄수)

공통 유틸 `formatCurrency(value, currency)` 하나로 전 화면 적용.

- 천 단위 콤마: `1,234,567`
- **외화(USD/JPY 등): 소수점 2자리, 버림(trunc) — 반올림 아님.** `1234.567 → 1,234.56`
- **원화(KRW): 정수, 버림(trunc).** `1234.9 → 1,234`
- 숫자는 우측 정렬 + `tabular-nums`
- 버림 구현 시 부동소수점 오차 주의 (예: `Math.trunc(value * 100) / 100` 대신
  정수 스케일링 또는 문자열 처리 검토)

## 재무제표 표시 규칙

- 연간 / 분기 탭 또는 토글로 구분
- **원본 표현 그대로**: 소스의 계정과목명·단위·부호를 재가공/환산하지 않음
  - 한국은 `fnlttSinglAcntAll`(전체 재무제표) 사용
- 마이너스 값: 빨간색 텍스트
- 주요 계정(매출액/영업이익/당기순이익 등): 배경색 강조, 대상 리스트는 설정값으로

## 날짜 처리 (버그 방지 — 필수)

- **입력 중간값을 파싱하지 말 것.** 연도 4자리 완성 / blur / 명시적 "조회"
  트리거 시에만 파싱·조회. `2027` 입력 중 `0002` 같은 값으로 조회 금지.
- 연도 범위 가드: 허용 범위(예: 1990~2100) 밖이면 조회 안 함.
- 날짜 계산 루프(`while (d < end)`)에는 **상한 카운터 필수**.
- `useEffect` 의존성 배열에 Date 객체 직접 넣지 말 것 →
  timestamp(숫자)나 ISO 문자열로 정규화 (매 렌더 새 참조 → 무한 리렌더).
- 직접 Date 산술 최소화, date-fns 사용.

## 멀티플

- 트레일링: 주가 + 재무로 **자체 계산** (PER, PBR, PSR, EV/EBITDA, 배당수익률 등). 인앱. 모든 시나리오 안전.
- 포워드 (개인용): `yahoo-finance2` `quoteSummary`로 forward EPS/매출·forward PER·목표주가·투자의견 인앱.
  원본 딥링크 병행. **팀/대외 확장 시 인앱 중단** → 딥링크 또는 정식 라이선스.

## 디자인

- 세련된 금융 대시보드. 정보 밀도 높되 정돈된 그리드, 카드 기반.
- 뉴트럴 베이스 + 포인트 컬러 절제. 다크/라이트 모드.
- 등락 색상은 시장 관행 (옵션화).
- 차트·테이블도 동일 디자인 토큰 공유.

## 대화

- 사용자와는 **한국어**로 대화.

## 미결 사항

`prd.md` §12 참조. 데이터 소스 평가는 §11 참조.
관련 결정이 필요하면 임의로 정하지 말고 사용자에게 확인.
