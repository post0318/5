# 글로벌 종목 리서치 대시보드

유니버스 종목의 **재무제표 · 공시 · 뉴스 · 멀티플**을 한 화면에서 조회하는 개인용 리서치 도구.
대상 시장: **한국 / 미국 / 일본**.

요구사항 전체는 [`prd.md`](./prd.md), 개발 규칙은 [`CLAUDE.md`](./CLAUDE.md) 참조.

## 실행

```bash
cp .env.example .env.local     # 필요 시 API 키 입력
npm install
npm run db:migrate             # 로컬 SQLite 스키마 생성 (data/app.db)
npm run dev                    # http://localhost:3000
```

## 현재 구현 상태

| 레이어 | 한국 | 미국 | 일본 |
|--------|------|------|------|
| L1 회사정보·재무제표·공시 | ✅ OpenDART (DART_API_KEY 필요) | ✅ SEC EDGAR (키 불필요) | ⏳ 골격 (EDINET_API_KEY 필요) |
| L2 EOD 시세 | ✅ Stooq → Yahoo(.KS/.KQ) 폴백 | ✅ | ✅ |
| L3 트레일링 멀티플 | ✅ 자체 계산 | ✅ | ✅ |
| L4 포워드 컨센서스 | ✅ yahoo-finance2(개인용) + 딥링크 | ✅ | ✅ |
| L5 뉴스 | ✅ 딥링크 | ✅ 딥링크 | ✅ 딥링크 |

- **종목 검색: 이름·코드 모두 지원** (한국=DART corpCode, 미국=EDGAR 티커맵, 일본=Yahoo search).
- 일본 L1 은 EDINET 키 발급 후 어댑터 구현 필요 (`src/lib/markets/jp/edinet.ts`).
- 트레일링 멀티플은 현재 **최근 연간 재무 기준** (정확한 TTM은 후속 과제).
- 한국 시세는 yahoo `.KS/.KQ` 폴백 사용 — 값 정확도는 소스 의존. 공공데이터포털 폴백은 후속(prd §4.4).

## 화면

- `/{market}/analysis` — 종목분석 (개요 · 재무제표 · 공시)
- `/{market}/universe` — 유니버스 통합 뷰
- `/manage` — 유니버스 관리 (개별 등록 · 일괄 업로드)

## 스택

Next.js 16 (App Router) · TypeScript · Tailwind 4 · shadcn/ui · TanStack Query/Table ·
Drizzle + libSQL(SQLite) · date-fns · yahoo-finance2

## 데이터 소스 주의 (prd.md §4.3)

`yahoo-finance2` / Stooq 는 **개인용/비상업 한정**. 팀·대외로 확장 시 해당 레이어를
사내 인포맥스 API 또는 정식 라이선스로 교체해야 한다. 크롤링은 어떤 경우에도 금지.
