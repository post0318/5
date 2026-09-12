# CLAUDE.md

이 파일은 Claude Code가 이 저장소에서 작업할 때 참고하는 가이드입니다.
제품 요구사항 전체는 `prd.md` 참조.

## 프로젝트

유니버스 종목의 재무제표 · 공시 · 뉴스 · 멀티플을 한 화면에서 조회하는
글로벌 종목 리서치 대시보드. 대상 시장: **한국 / 미국 / 일본**.

## 기술 스택

- Next.js 16 (App Router) + TypeScript, Turbopack
- Tailwind CSS 4 + shadcn/ui (radix-nova preset), next-themes 다크/라이트
- TanStack Query (클라이언트 패칭), TanStack Table v8
- Recharts (차트 — 아직 미사용)
- Drizzle ORM + libSQL(SQLite, `data/app.db`) — 개인용. 확장 시 Postgres 이식
- date-fns, zod
- yahoo-finance2 (서버 전용, `serverExternalPackages` 등록됨)

## 코드 구조

```
src/lib/format.ts              숫자·통화 포맷 (콤마, trunc)
src/lib/dates.ts               날짜 방어 (연도 완성 판정, 루프 상한)
src/lib/db/                    Drizzle 스키마 + 클라이언트
src/lib/markets/
  types.ts                    MarketAdapter 인터페이스 + DTO
  registry.ts                 market → adapter
  service.ts                  getStockOverview (L1~L4 병렬 집계)
  deeplinks.ts                L4/L5 딥링크 URL 빌더
  multiples.ts                L3 트레일링 멀티플 계산
  search.ts                   종목명·코드 검색 (시장별)
  us/edgar.ts                 미국 L1 (SEC EDGAR) + searchEdgarTickers
  kr/opendart.ts              한국 L1 (OpenDART)
  kr/corpcode.ts              corpCode.xml(zip) → stock_code↔corp_code, 이름 검색
  jp/edinet.ts                골격 (EDINET 키 발급 후 구현)
  quote/                      Stooq + yahoo EOD(.KS/.KQ 폴백), 오케스트레이터
src/lib/universe/repo.ts       유니버스 CRUD + 일괄 파서
src/app/api/                   Route Handlers
src/components/                UI (num.tsx=포맷 표시, financials-table 등)
```

## 명령어

```
npm run dev          # 개발 서버 (Turbopack)
npm run build        # 프로덕션 빌드 (타입체크 포함)
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run db:generate  # 스키마 변경 후 마이그레이션 생성
npm run db:migrate   # 마이그레이션 적용 (로컬 data/app.db)
npm run db:studio    # drizzle studio
```

커밋 전 `npm run build` 와 `npm run lint` 통과 확인.

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
| L5 뉴스 | `yahoo-finance2` `search` / 규제기관 공시 + 딥링크 / Google 뉴스 RSS(제목·출처·링크, 무료 번역) | 인앱 목록 + 딥링크 |

- **크롤링은 어떤 시나리오에서도 금지**: FnGuide(`robots.txt Disallow: /`),
  stockanalysis·MarketScreener(ToS) → 딥링크만.
  - **예외 1건 (개인용, 오너 명시 승인)**: 외국인 코스피200 선물 순매수(투자자별
    거래실적)는 어떤 공식 무료 API에도 없고(KRX OPEN API·KIS 확인), KRX 정보데이터
    시스템 화면은 로그인 필수 + Vercel IP 차단. **로컬 전용 스크립트**
    (`scripts/collect-foreign-fut.mjs`)가 네이버페이 증권 "투자자별 매매동향(선물)"
    페이지를 **하루 1회** 파싱해 `/api/cron/kr-fg` 로 POST 한다.
    - `finance.naver.com/robots.txt` 는 일반 UA 에 `Disallow: /` (FnGuide 와 동일
      상황). 오너가 "개인용·하루 1회·단일 소형 페이지" 조건으로 예외 승인.
      **빈번한 폴링 금지.**
    - 앱 배포본에는 크롤링 코드가 없다. 이 스크립트는 로컬 도구.
    - **자동 실행 경로 확장 (2026-09, 오너 승인)**: 로컬 PC 전원 상태에 의존하지
      않도록 동일 스크립트를 GitHub Actions(`.github/workflows/foreign-futures.yml`,
      하루 1회 스케줄)로도 돌린다. "개인용·하루 1회" 조건은 그대로 유지 —
      이 저장소 소유자만 쓰는 개인 자동화이고 앱 배포본(Vercel)에는 여전히
      크롤링 코드가 안 들어간다는 점은 동일. 로컬 스크립트는 수동/백업용으로
      계속 둔다.
  - **예외 2건 (개인용, 오너 명시 승인, 2026-09)**: `stock.naver.com`(및
    `m.stock.naver.com`)의 종목 리서치(애널리스트 리포트) 페이지
    (`/domestic/stock/{code}/research`). robots.txt 가 `Disallow: /` 라
    다른 항목과 동일하게 예외 승인 필요 — 승인은 됐으나 실제 로딩에 쓰는
    JSON 엔드포인트를 아직 못 찾음(추정 경로 시도 실패). 다음 작업 시
    실제 API 경로부터 확인할 것.
  - **예외 3건 (개인용, 오너 명시 승인, 2026-09)**: 신한투자증권 "기업분석"
    리포트 — `bbs2.shinhansec.com/bbs/list/gicompanyanalyst` (로그인 불필요
    JSON API, 페이지 소스엔 없고 클라이언트 JS가 호출하는 내부 엔드포인트를
    역추적해 확인). `bbs2.shinhansec.com/robots.txt` 가 `Disallow: /` 라
    다른 항목과 동일 조건(개인용·로컬 실행·저빈도)으로 예외 승인.
    **로컬 전용 스크립트** (`scripts/collect-shinhan-research.mjs`, 하루 1회
    GitHub Actions `.github/workflows/shinhan-research.yml`)가 최근 N일치를
    수집해 `/api/cron/shinhan-research` 로 POST → MongoDB(`kr_research`)
    저장. 원본 PDF·전체 본문은 저장하지 않고 목록에 이미 노출되는 요약 발췌만
    저장(용량 관리, 180일 보관 후 정리). 앱 배포본은 DB 조회만
    (`/api/markets/kr/[symbol]/research`) — 크롤링 코드가 배포본에 없다는
    원칙은 동일. 종목명→종목코드 매핑은 `lib/markets/kr/corpcode.ts`(정적
    데이터, DART_API_KEY 불필요) 재사용.
    - **한 증권사로 한정하지 않음(오너 지적, 2026-09)**: 스키마(`ShinhanResearchDoc`)에
      `source` 필드를 두고 `_id`도 `${source}:게시글번호`로 네임스페이스,
      `/api/cron/shinhan-research`도 body의 `source`를 그대로 받아 저장하므로
      다른 증권사 수집 스크립트를 추가해도 같은 라우트·컬렉션을 재사용 가능.
      화면(`ShinhanResearch` 컴포넌트)도 항목마다 출처 배지를 표시하도록
      이미 대응. **미결**: 신한 사이트 자체에 있는 "전 증권사 리포트" 통합
      화면(`/WEB-APP/wts/main/index.cmd?screen=3501`)이 더 나은 단일 소스일
      수 있어 확인했으나, 레거시 WTS(트레이딩 단말) 모듈이라 단순 JSON API가
      아닐 가능성이 높음 — 다음 작업 시 이 경로부터 파봐서 실제 데이터 접근
      방식을 확인할 것.
    - **하나증권 추가(오너 확인, 2026-09)**: `www.hanaw.com` 리서치센터
      (`/main/research/research/list.cmd?pid=3&cid=2&curPage=N`)는 로그인 없이
      서버렌더링 HTML로 그대로 나온다(신한과 달리 JSON API 역추적 불필요 —
      평범한 GET 쿼리스트링 페이지네이션). 제목이 "종목명(종목코드.거래소/
      투자의견): 제목" 형식으로 고정돼 있어 이름 검색 없이 제목에서 바로
      종목코드를 뽑는다. `robots.txt` 는 `Disallow: /`(Googlebot·Yeti 제외) —
      동일 조건으로 예외 승인. **로컬 스크립트**
      (`scripts/collect-hana-research.mjs`, GitHub Actions
      `.github/workflows/hana-research.yml`, 하루 1회)가 같은
      `/api/cron/shinhan-research` 라우트를 `source: "하나증권"` 으로 재사용.
    - **한화투자증권 추가(오너 확인, 2026-09)**: `www.hanwhawm.com` 기업분석
      (`/main/research/main/list.cmd?depth3_id=anls1&p=N`)은 로그인 없이
      서버렌더링 HTML. **robots.txt 가 이 경로를 막지 않음**(다른 항목과 달리
      `Disallow: /` 아님 — 좁은 경로 몇 개만 차단) — 별도 예외 승인이 딱히
      필요 없는 가장 깨끗한 소스. 제목이 "[업종] 종목명[코드/의견] 제목"
      형식이라 제목에서 종목코드를 뽑는다. 목록에 PDF 직링크가 없어 상세보기
      URL(`view.cmd?...&seq=N`)을 대신 연결. **로컬 스크립트**
      (`scripts/collect-hanwha-research.mjs`, GitHub Actions
      `.github/workflows/hanwha-research.yml`)가 같은 라우트를
      `source: "한화투자증권"` 으로 재사용.
    - **유안타증권 추가(오너 확인, 2026-09)**: `www.myasset.com` 기업분석
      (`/myasset/research/rs_list/rs_list.cmd?cd007=RE01&page=N&pgCnt=30`)은
      로그인 없이 서버렌더링 HTML(표 형식). robots.txt 자체가 없는 사이트라
      다른 예외들과 동일 조건으로 승인. `data-jongcode="(코드)"` 속성에
      종목코드가 그대로 있어 이름 검색 불필요. **미해결**: 개별 리포트 PDF의
      정확한 다운로드 URL을 못 찾아 `pdfUrl` 은 비워둠(제목·종목·의견·
      애널리스트·날짜는 정상 수집) — 다음에 실제 브라우저 네트워크 요청을
      봐서 채울 것. **로컬 스크립트**
      (`scripts/collect-yuanta-research.mjs`, GitHub Actions
      `.github/workflows/yuanta-research.yml`)가 같은 라우트를
      `source: "유안타증권"` 으로 재사용.
    - **교보증권 추가(오너 확인, 2026-09)**: `www.iprovest.com` 화면은 iframe
      4중 중첩(레거시 웹로직)이지만, 실제 데이터를 뿌리는 서블릿
      (`/weblogic/RSReportServlet?scr_id=32&menuCode=1&pageNum=N`)은 로그인 없이
      평범한 GET으로 직접 열림(오너가 실제 사이트에서 확인해 링크를 알려줘서
      역추적 성공). 응답이 **EUC-KR 인코딩**이라 `TextDecoder("euc-kr")` 로
      변환 필요(Node 기본 지원 확인됨). "최신리포트" 게시판에 기업분석·
      산업분석이 섞여 있어 구분 컬럼으로 기업분석만 필터링. 종목명은 코드
      없이 이름만 나와 `corpcode.ts` 이름 검색으로 매핑. PDF는 로그인이
      필요해(오너 확인) 상세보기 링크(로그인 없이 본문 열람 가능, 오너 확인)를
      대신 연결. robots.txt 확인이 애매해(4중 프레임 구조) 보수적으로 다른
      예외와 동일 조건 적용. **로컬 스크립트**
      (`scripts/collect-kyobo-research.mjs`, GitHub Actions
      `.github/workflows/kyobo-research.yml`)가 같은 라우트를
      `source: "교보증권"` 으로 재사용.
    - **한경 컨센서스 추가(오너 확인, 2026-09)**: `consensus.hankyung.com` —
      개별 증권사 자사 사이트가 아니라 **한국경제신문이 거의 모든 증권사의
      리포트를 한곳에 모아 재가공한 3자 편집 서비스**라는 점이 위 항목들과
      다름(오너도 이 차이를 인지하고 승인). "제공출처" 컬럼에 실제 작성
      증권사명이 그대로 나와 신한·하나·한화·유안타·교보뿐 아니라 그 목록에
      없던 증권사(예: iM증권, IBK투자증권, LS증권 — 실측 확인)까지 한 번에
      커버. 로그인 없이 평범한 GET(`/analysis/list?sdate=&edate=&now_page=N`),
      PDF도 로그인 없이 바로 열림(`/analysis/downpdf?report_idx=N`, 확인됨).
      "기업" 분류 제목이 "종목명(코드) 제목" 형식이라 이름 검색 불필요.
      robots.txt 는 `Disallow: /` — 다른 예외와 동일 조건으로 승인.
      **로컬 스크립트** (`scripts/collect-hankyung-research.mjs`, GitHub
      Actions `.github/workflows/hankyung-research.yml`)가 항목별 실제
      작성 증권사명을 `source` 로 그룹핑해 같은 라우트에 나눠 전송(라우트는
      호출당 source 하나만 받으므로). 개별 증권사 스크립트들을 대체하진
      않고 보완 — 같은 리포트가 두 소스에 중복 저장될 수 있으나 `_id` 가
      소스별로 네임스페이스돼 있어 기능상 문제 없음(화면엔 중복 카드로만
      보일 수 있음, 추후 정리 여지).
    - **대신증권 — 제외(오너 결정, 2026-09)**: `www.daishin.com` 의 "기업분석"·
      "글로벌 기업분석" 메뉴가 둘 다 로그인 페이지로 리다이렉트되는 것만
      확인된 상태에서 오너가 진행 중단 결정. 재검토하지 않음.
    - **로그인이 필요한 증권사는 이 프로젝트 방식 대상이 아님**: 실거래
      계좌 자격증명을 자동화 스크립트/CI 시크릿에 두는 것은 지금까지의
      "공개 페이지 개인용 크롤링" 예외와 성격이 전혀 다른(데이터센터 IP
      자동 로그인은 이상거래탐지·계정잠김 위험) 별개 문제라 진행하지 않음
      (오너가 실계좌 로그인 자동화를 요청했을 때 설명·거절한 사례 있음).
- **종목뉴스 / 주요 코멘트 탭 (`src/lib/news/`)**: Google 뉴스 RSS(`news.google.com/rss/...`,
  공개 신디케이션 피드 — 기사 본문 스크래핑 아님, 제목·출처·발행시각·원문 링크만)를
  구독하고, 영·일문 제목은 무인증 Google 번역 웹 엔드포인트(실패 시 MyMemory)로
  한국어 번역한다. LLM 요약 없음(비용·본문 소스 미확보로 보류). `post0318/4`
  프로젝트의 `src/lib/server/{brazilNews,translate}.ts` 와 동일 패턴을 이식.
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
- 등락 색상은 시장 관행: **한국은 상승=빨강·하락=파랑, 미국/일본은 상승=녹색·
  하락=적색**(2026-09 확정). `--kr-up`/`--kr-down`(globals.css) +
  `stockDirClass(positive, market)`(`components/num.tsx`)로 구현. 적용 대상은
  **주가·투자의견과 직접 연계된 표시만**(종가·목표주가 등락률, 52주 최고/최저,
  Yahoo 추천의견, 캔들차트) — 재무제표의 마이너스 값(빨간 텍스트)·성장률%
  등에는 적용하지 않는다(그쪽은 시장 무관 고정 규칙, 별개).
- 차트·테이블도 동일 디자인 토큰 공유.

## 대화

- 사용자와는 **한국어**로 대화.

## 미결 사항

`prd.md` §12 참조. 데이터 소스 평가는 §11 참조.
관련 결정이 필요하면 임의로 정하지 말고 사용자에게 확인.
