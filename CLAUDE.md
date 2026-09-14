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
  MarketScreener(ToS) → 딥링크만.
  - **stockanalysis.com 은 2026-09 재검토 후 제한적으로 허용**(오너 승인).
    기존 "ToS 위반" 판단이 실제 문구 확인 없이 내려진 것이었음 — 실측:
    `robots.txt` 는 `/e/`·`/p/` 만 막고 `/stocks/*/forecast/` 는 허용,
    ToS(`/terms-of-use/`)에는 크롤링·자동화·robot·spider 금지 조항이 아예
    없고 *"It is not allowed to republish our content in full ... However,
    you can use snippets of the content as long as you do not modify the
    content and clearly state where you got it from"* 이라고 명시.
    → **snippets + 출처 명시 + 하루 1회 + 종목당 5행**만 허용. 전체 목록·
    본문·차트 재게시 금지. 상세는 아래 예외 항목 참고.
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
  - **네이버(`stock.naver.com`/`m.stock.naver.com`) 종목 리서치 페이지 — 폐기
    (오너 결정, 2026-09)**: 예외 승인은 받았으나 실제 로딩에 쓰는 JSON
    엔드포인트를 끝내 못 찾아(추정 경로 시도 실패) 착수 전 단계에서 중단.
    더 이상 추진하지 않음 — 재검토 대상 아님.
  - **예외 2건 (개인용, 오너 명시 승인, 2026-09)**: 신한투자증권 "기업분석"
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
    - **신한투자증권 해외(미국 종목) 추가(오너 확인, 2026-09)**: 같은 API
      베이스(bbs2.shinhansec.com)의 다른 게시판 — 화면(투자정보 > 투자전략 >
      해외 산업 및 기업분석, `/siw/insights/global/foreignstock/view.do`)의
      Knockout.js 바인딩에 찍힌 `boardName=foreignstock` 을 그대로 API
      슬러그로 써서 발견. 제목 "종목명(TICKER.US)" 에서 티커를 뽑고, 그 외
      시장(JP/SH/DE 등)은 건너뜀. 목표주가는 공용 추출기
      (`us-research-extract.mjs`)의 컨센서스 패턴으로 PDF에서 보강. **로컬
      스크립트** (`scripts/collect-shinhan-overseas-research.mjs`, GitHub
      Actions `.github/workflows/shinhan-overseas-research.yml`, 하루
      1회)가 같은 라우트를 `source: "신한투자증권", market: "us"` 로 재사용.
      - **산업분석/투자전략 수집 추가(오너 지시, 2026-09 — "한국과 미국 모두
        동일하게 수집 기반 구축")**: 이 게시판에 종목코드 자체가 없는
        "글로벌 전략; Global Portfolio (날짜)" 시리즈(f2 필드가 "-")가
        섞여 있는데 티커 패턴에 안 걸려 통째로 버려지고 있었다(실측: 80건
        중 29건 매칭 실패, 그중 다수가 이 시리즈). `category:"산업"`,
        `symbol` 항상 null로 별도 수집(목표주가·투자의견 추출은 건너뜀 —
        특정 종목 얘기가 아니므로 PDF에 우연히 등장하는 숫자를 잘못 채울
        위험). 다른 나라 티커(JP/SH/DE)가 붙은 항목은 계속 건너뜀(이
        수집기는 미국 전용).
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
      - **산업분석 추가(오너 지시, 2026-09 — "한국과 미국 모두 동일하게
        수집 기반 구축")**: 같은 메뉴의 형제 게시판(`cid=1`, 기업분석은
        `cid=2`)이 업종분석 — 제목이 "업종명(투자의견): 제목"(괄호가 없는
        경우도 있음, 예: "에너지/화학: Weekly Monitor: ...") 형식이라 별도
        정규식(`INDUSTRY_TITLE_RE`)으로 업종명만 뽑는다. `category:"산업"`,
        symbol 항상 null, 목표주가 추출도 건너뜀.
      - **하나증권 해외(미국 종목) 추가**: 같은 사이트·같은 목록 구조인데
        게시판만 다르다(`pid=8&cid=3`, "글로벌 기업분석"). 제목이 "종목명
        (TICKER.거래소): 제목" 형식, .US 만 골라 미국 종목으로 저장. 목표
        주가는 공용 추출기(`us-research-extract.mjs`)로 본문/PDF에서 추출
        (예: "TP(컨센서스) 308.9 USD"). **버그 수정(2026-09, 오너 지적 —
        "애플 하나증권에서 pdf에 pt가 있는데 보여주지 못하고 있다")**: 국내
        수집기에서 그대로 복사해온 원화(KRW) 기준 목표주가 추출 함수가
        안 쓰이는 채로 남아있었다(lint no-unused-vars 경고로 발견) — 실제
        추출은 이미 공용 모듈이 정상 수행 중이었고, DB에 남아있던 옛 null
        값만 재수집으로 갱신. **로컬 스크립트**
        (`scripts/collect-hana-global-research.mjs`)가 같은 라우트를
        `source: "하나증권", market: "us"` 로 재사용.
      - **글로벌 산업분석/투자전략 게시판 해결(오너 지시, 2026-09 — "하나증권의
        문제는 그러면서 해결해보자")**: 이전 조사에서 "글로벌리서치 > 글로벌
        산업분석"(`pid=8&cid=2`)/"글로벌 투자전략"(`pid=8&cid=1`) 메뉴가
        "모던 그리드(WEB-APP) 컴포넌트라 정적 HTML에 데이터가 없다"고 미결로
        남겨뒀었는데, **그 판단이 잘못됐던 것으로 확인됨** — 직접 다시
        확인한 결과 다른 하나증권 게시판(글로벌 기업분석 등)과 완전히 같은
        서버렌더링 HTML 목록이었다. "해외주식 > {카테고리}" 라벨이 목록에
        그대로 있어 산업분석/투자전략 구분도 파싱만으로 바로 됨. 다만 이
        두 게시판은 "해외주식" 산하이면서도 중국·인도·신흥국 등 미국 외
        내용이 섞여 있어(실측), 미국/글로벌 매크로 신호어가 있는 항목만
        market:"us"로 수집하고 나머지는 건너뛴다(키워드 추측, 미래에셋과
        동일한 트레이드오프 — 완전하지 않음). **로컬 스크립트**
        (`scripts/collect-hana-global-industry-research.mjs`, GitHub
        Actions `.github/workflows/hana-global-industry-research.yml`,
        하루 1회)가 같은 라우트를 `source: "하나증권", category:"산업"` 으로
        재사용.
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
      종목코드가 그대로 있어 이름 검색 불필요. **PDF 링크 해결(2026-09)**:
      목록 행의 `cmd-type='download' data-seq='2026/0910/172546/..._ko.pdf'`
      값을 `https://file.myasset.com/sitemanager/upload/` 뒤에 그대로 붙이면
      로그인 없이 200 응답(실측 확인) — `pdfUrl` 정상 채움.
      **본문 발췌(2026-09 추가)**: 다른 증권사와 달리 목록 HTML에 요약문이
      없어, 다른 소스들처럼 "목록에 이미 노출되는 요약"을 그대로 못 쓴다.
      대신 PDF를 내려받아 `pdf-parse`(무료 오픈소스 npm, 로컬 처리 — 과금
      없음)로 텍스트를 뽑고, 모든 리포트에 고정으로 등장하는
      "주가수익률 (%) ..." 통계 블록(헤더+절대/상대/절대(달러환산) 3줄) 다음
      부터 150자 내외만 짧게 잘라 저장한다. PDF 원문·전체 본문 텍스트는
      저장하지 않음 — 다른 증권사의 "요약 발췌만 저장" 정책과 동일 성격으로
      오너 확인. PDF 다운로드는 매번 비용이 드는 작업이라 이 수집기만
      `--days` 기본값을 14 → 3으로 좁혀서(다른 수집기와 달리) 매일 최근
      며칠 치만 다시 훑는다 — 서버가 보낸 항목을 통째로 replace하기 때문에,
      기본값을 넓게 잡으면 이미 발췌해둔 옛 항목까지 매일 재다운로드하게
      된다. 백필 시 `--days=30` 등으로 수동 실행. **로컬 스크립트**
      (`scripts/collect-yuanta-research.mjs`, GitHub Actions
      `.github/workflows/yuanta-research.yml`)가 같은 라우트를
      `source: "유안타증권"` 으로 재사용.
      **중단(오너 지시, 2026-09)**: myasset.com 직접 스크래핑이 발췌·
      목표주가·투자의견 추출에서 계속 실패해 한경 컨센서스 경유(아래
      항목, `report_type=CO` 구조화 컬럼 — 훨씬 안정적)로 전환. 이 워크플로
      스케줄은 비활성화(`workflow_dispatch`만 남김), 스크립트 파일은 참고용
      보존. 유안타 데이터는 이제 한경 스크립트가 `source: "유안타증권"`으로
      계속 수집(제외 필터 제거함).
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
      - **산업분석 수집 추가(오너 지시, 2026-09 — "한국과 미국 모두 동일하게
        수집 기반 구축")**: "구분" 컬럼이 "산업분석"인 행은 종목이 아니라
        업종이라 예전엔 통째로 버렸는데, `category:"산업"`으로 별도 수집
        (symbol 항상 null, stockName 은 종목/업종 컬럼 값 그대로 — 산업분석
        행엔 업종명이 들어있음). 목표주가·투자의견 추출도 건너뜀.
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
      소스별로 네임스페이스돼 있고, 읽기 단계(`getShinhanResearchBySymbol`)
      에서 같은 출처(source)+제목이 완전히 같으면 하나만 보여주는 dedupe도
      있어 기능상 문제 없음. **유안타증권은 여기서 제외하지 않는다**(2026-09
      결정 — 자체 스크립트의 myasset.com 스크래핑이 계속 불안정해 한경 경유
      `report_type=CO` 구조화 컬럼 쪽을 신뢰).
      - **산업분석/투자전략 수집 추가(오너 지시, 2026-09)**: "산업분석/투자전략"
        탭 준비(KB증권과 같은 작업, 수집기부터 구축). 화면의 "분류선택"
        드롭다운에서 `report_type=IN`("산업")·`MA`("시장") 값을 확인 —
        지금까지 `CO`("기업")만 요청해 이 두 분류는 "종목명(코드)" 제목
        패턴이 아니라서 전부 버려지고 있었다. IN/MA 응답은 적정가격 컬럼
        자체가 없어(특정 종목 얘기가 아니므로) 컬럼 순서가 하나 앞당겨지는
        걸 확인해 별도 파서(`parseIndustryItems`)로 처리. 제목이 "[업종명]
        헤드라인" 형식이면 대괄호를 업종명으로 뽑고, 없으면 분류 라벨을
        그대로 씀. `category:"산업"`, `symbol` 항상 null로 전송(KB와 동일
        라우트 안전장치 재사용). **미결**: 업종→종목 매칭·탭 UI는 KB와
        마찬가지로 다음 과제.
        - **버그 수정(2026-09)**: MA(시장) 분류는 "투자의견" 컬럼 자체가
          없어(헤더가 작성일/제목/작성자/제공출처 4칸뿐 — IN은 5칸) IN과
          같은 셀 인덱스로 읽으면 작성자·제공출처가 한 칸씩 밀려 뒤바뀐다
          (실측으로 발견 — MA 항목 전원의 제공출처가 빈 값으로 저장되고
          있었음). `parseIndustryItems`에 `reportCode`를 넘겨 MA/IN 컬럼
          수를 구분해서 읽도록 수정.
    - **NH투자증권 추가(오너 확인, 2026-09)**: `www.nhsec.com` 은 레거시
      frameset 사이트라 실제 콘텐츠는 `/main.html` 프레임 안에 있고, 화면이
      호출하는 내부 TR(트랜잭션) API `/research/boardCommonTrAjax.action`
      (`trName=H3211`)을 직접 역추적해 호출한다(DOM 스크레이핑 아님). 로그인
      불필요, 응답은 EUC-KR 인코딩 JSON. 페이지네이션은 번호가 아니라 커서
      방식(마지막 행의 `rsh_ppr_no`/일시를 다음 요청에 그대로 실어 보냄),
      `rmt_cnt`를 아무리 크게 줘도 서버가 최대 20건으로 잘라 응답(실측
      확인). 응답에 종목코드(`rsh_ppr_iem_cd_pcl`, 산업 리포트는 콤마로 여러
      개)와 PDF 직링크(`hpge_fle_url_cts`)가 이미 들어있어 제목 파싱·이름
      검색이 불필요 — 종목명은 표시용으로만 `corpcodes.json` 역조회.
      `robots.txt` 는 `Disallow: /`(Googlebot 등 예외) — 다른 항목과 동일
      조건으로 예외 승인. **로컬 스크립트**
      (`scripts/collect-nh-research.mjs`, GitHub Actions
      `.github/workflows/nh-research.yml`, 하루 1회)가 같은 라우트를
      `source: "NH투자증권"` 으로 재사용.
      - **산업분석 수집 추가(오너 지시, 2026-09 — "한국과 미국 모두 동일하게
        수집 기반 구축")**: 응답 필드 `rsh_ppr_ser_cd_nm`이 이미 "기업"/"산업"
        을 명시적으로 구분해준다(실측 확인, 브라켓 제목을 추측할 필요 없음).
        종목코드 0개 + `ser_cd_nm==="산업"`인 항목만 `category:"산업"`으로
        수집(코드 0개 + "기업"인 항목은 미상장·코드 매칭 실패라 기존처럼
        건너뜀). 목표주가·투자의견 추출도 건너뜀.
    - **NH투자증권 해외기업분석(미국 종목) 추가(오너 확인, 2026-09)**: 같은
      TR(H3211)을 게시판 코드(`rsh_ppr_dit_cd`) "01"(기업/산업분석, 국내
      수집기와 동일)로 스캔하면 종목코드가 비어 있는 "[해외기업분석/회사명]"
      형식 리포트가 드물게 섞여 나온다(90일 3건). **오너가 "nh투자증권
      해외주식에 있는데?"라고 지적**해 메뉴를 다시 확인한 결과, 별도로
      "해외주식" 전용 게시판(`rsh_ppr_dit_cd=03`)이 존재함을 확인 — 같은
      대괄호 제목 형식을 훨씬 높은 밀도로 담고 있다(90일 95건 중 60건
      매칭, 실측). 두 게시판 모두 종목코드 필드는 비어 있어 여전히 제목
      패턴으로 걸러야 하고, 회사명(영문/한글)은 네이버 해외종목 자동완성으로
      티커 해석(DS투자증권 수집기와 동일 방식). **로컬 스크립트**
      (`scripts/collect-nh-overseas-research.mjs`, GitHub Actions
      `.github/workflows/nh-overseas-research.yml`, 하루 1회)가 "03"과 "01"
      둘 다 스캔해 합친 뒤 같은 라우트를 `source: "NH투자증권", market: "us"`
      로 재사용. 목표주가는 공용 추출기(`us-research-extract.mjs`)의
      컨센서스 패턴으로 PDF에서 보강(90일 백필 46건 중 42건 확보). **미결**:
      투자의견(등급)은 현재 0건 추출 — NH 리포트 PDF의 등급 표기 위치/형식이
      다른 브로커와 달라 보이며, 우선순위 낮아 추후 재확인 필요.
      - **산업분석/투자전략 수집 추가(오너 지시, 2026-09 — "한국과 미국 모두
        동일하게 수집 기반 구축")**: "해외주식" 전용 게시판(03)에 종목코드
        없는 "[전략 인사이드/미국] 헤드라인"(국가별 전략 시리즈)·"[글로벌
        사이버보안 산업] 헤드라인"(슬래시 없는 순수 업종명) 형식이 섞여
        있는데 지금까지 버려지고 있었다. `category:"산업"`으로 수집하되
        **"전략 인사이드" 시리즈는 미국 회차만** 포함(중국·일본 등 다른
        나라 회차는 건너뜀 — 이 수집기는 미국 전용). ⚠️ **주의**: 이 산업/
        전략 폴백은 반드시 게시판 "03"(해외주식)에만 적용해야 한다 — 국내
        게시판(01)도 평범한 국내 종목 리포트가 "[종목명] 헤드라인" 대괄호
        형식을 쓰기 때문에(예: "[대우건설] 팀코리아 대표 시공 파트너") 게시판
        구분 없이 적용하면 국내 종목이 "미국 산업분석"으로 잘못 편입된다
        (실측으로 재현·수정한 버그 — 원본 rawRows 에 `__ditCd` 태그를 남겨
        구분).
    - **미래에셋증권 추가(오너 확인, 2026-09)**: `securities.miraeasset.com` 도
      레거시 frameset 사이트지만 목록 자체(`/bbs/board/message/list.do?
      categoryId=1800&curPage=N`, categoryId 는 "투자정보 > 리서치 리포트 >
      기업분석" 메뉴의 `javascript:openHp(...)` 링크를 역추적해 확인)는
      평범한 서버렌더링 HTML(EUC-KR)이라 GET으로 바로 받는다. 국내(6자리
      코드)·해외(예: "IONQ US") 리포트가 한 목록에 섞여 있어 6자리 숫자
      코드가 아닌 항목은 건너뜀. 제목·종목명·코드·투자의견·PDF 직링크
      (`downConfirm(...)` 첫 인자, 로그인 없이 다운로드 확인)가 모두 목록에
      있어 이름 검색 불필요. `robots.txt` 에 `Disallow` 규칙 자체가 없어
      지금까지 중 가장 깨끗한 케이스. **로컬 스크립트**
      (`scripts/collect-mirae-research.mjs`, GitHub Actions
      `.github/workflows/mirae-research.yml`, 하루 1회)가 같은 라우트를
      `source: "미래에셋증권"` 으로 재사용.
      - **산업분석/투자전략 수집 추가(오너 지시, 2026-09 — "한국과 미국 모두
        동일하게 수집 기반 구축")**: 검색엔진 색인으로 형제 게시판을 확인
        (categoryId 를 브루트포스로 못 찾아 웹 검색으로 발견) —
        `categoryId=1525`(산업분석, 국내/해외 혼재)·`1527`(투자전략). 목록
        항목이 이미 "&lt;b&gt;주제명&lt;/b&gt;&lt;br/&gt;헤드라인" 구조라
        종목처럼 코드/티커를 뽑을 필요 없이 굵은 글씨 부분을 그대로 라벨로
        쓴다. `category:"산업"`, 목표주가 추출은 건너뜀.
        - **KR/US 분류 — 키워드 추측(오너 지시, 2026-09 — "kb 미래에셋
          미국 산업과 투자전략은?")**: KB의 `foldertemplate` 같은 국가 구분
          필드가 이 게시판엔 전혀 없고, GM(GlobalMonitor)에도 미래에셋
          데이터가 아예 없어(실측 확인 — auth 목록에 없음) 대체도 안 된다.
          오너가 "정확한 분류"보다 "키워드 추측" 쪽을 선택(대안: 전부 kr
          유지, 또는 브라우저로 직접 확인)해 `classifyMarket()`으로 제목·
          라벨을 검사한다 — 중국/인도/일본 등 타국이 명시되면 건너뛰고,
          "글로벌/Global/해외/미국/US/나스닥/연준" 등 신호가 있으면 us,
          그 외(업종명+비중확대 등 국내 관행)는 kr. **완전하지 않음** —
          실측으로 확인된 오분류 사례: "자동차/모빌리티... 미국 Ford 넘어
          3위"(내수 얘기인데 us로 분류됨), "AI Infra Signal... 델과 HPE"
          (미국 얘기인데 신호어가 없어 kr로 남음). 정밀 분류가 필요해지면
          브라우저로 실제 사이트를 봐야 할 수도 있음.
    - **한국투자증권 추가(오너 확인, 2026-09)**: `securities.koreainvestment.com`
      은 모던 사이트라 목록(`/main/research/research/Strategy.jsp?jkGubun=10
      &category1=05&category2=01&rowsPerPages=50&currentPage=N`)이 평범한
      서버렌더링 HTML(UTF-8)로 바로 나온다. 상세 페이지도 로그인 없이 전체
      본문이 보이지만(실측 확인) 이 프로젝트 방침상 목록의 요약 발췌만
      저장. **PDF 원문은 로그인 필요**(`prePdfFileView()`가 비로그인 시
      `login.jsp`로 리다이렉트, 실측 확인) — 교보증권과 동일 패턴으로 로그인
      없이 열리는 상세 페이지 URL을 대신 연결. 제목이 "종목명 (코드):제목"
      (일부는 앞에 "AIR 스몰캡" 같은 태그가 더 붙어 지저분함) 형식이라 코드만
      뽑고, 종목명은 `corpcodes.json` 역조회로 깔끔하게 대체. `robots.txt`
      는 `Disallow: /`(Googlebot 등 예외) — 다른 항목과 동일 조건으로 예외
      승인. **로컬 스크립트** (`scripts/collect-kis-research.mjs`, GitHub
      Actions `.github/workflows/kis-research.yml`, 하루 1회)가 같은 라우트를
      `source: "한국투자증권"` 으로 재사용.
      - **산업분석 수집 추가(오너 지시, 2026-09 — "한국과 미국 모두 동일하게
        수집 기반 구축")**: `category2` 파라미터 값(01/02/03)을 바꿔도 서버가
        같은 통합 피드를 반환한다(실측 확인 — 별도 게시판이 아님). 종목코드
        없는 "업종명:헤드라인" 형식(예: "화장품:예견된 조정...")이 이미 같은
        피드에 섞여 있는데 `TITLE_RE`(코드 필요)에 안 걸려 버려지고 있었다 —
        `INDUSTRY_TITLE_RE`로 콜론 앞부분을 업종 라벨로 뽑아 `category:"산업"`
        으로 수집(symbol 항상 null, 투자의견·목표주가 조회도 건너뜀).
    - **KB증권 추가(오너 확인, 2026-09)**: `www.kbsec.com` 리서치보고서
      "산업/기업" 탭이 호출하는 내부 TR API(`/go.able?linkcd=s040203010001`,
      POST, `tab=5`)를 직접 역추적해 호출한다. 로그인 불필요, 응답은 UTF-8
      JSON. `searchMonth=3` 하나로 최근 3개월치를 한 번에 받아 와 다른
      브로커와 달리 페이지네이션 자체가 불필요. 제목이 "종목명 (코드)" +
      별도 부제(`docTitleSub`, 실제 헤드라인) 필드로 깔끔히 분리돼 있고
      투자의견(`recomm`, 영문)·PDF 직링크(`urlLink`)도 목록에 포함. 종목코드
      없이 업종명만 있는 리포트(대표 종목코드가 임의로 딸려있는 경우 포함)는
      제목이 "종목명 (코드)" 패턴이 아니므로 자동으로 걸러짐. **PDF도 실측
      결과 로그인 없이 다운로드됨**(오너가 "kb는 pdf는 로그인해야하나 본문은
      가능하다"고 전달했던 것과 달리, 최소 "산업/기업" 게시판 PDF는 로그인
      불필요로 확인됨). `www.kbsec.com`·`rdata.kbsec.com` 모두 robots.txt
      자체가 없음(가장 깨끗한 케이스) — 그래도 다른 예외들과 동일 조건으로
      승인. **로컬 스크립트** (`scripts/collect-kb-research.mjs`, GitHub
      Actions `.github/workflows/kb-research.yml`, 하루 1회)가 같은 라우트를
      `source: "KB증권"` 으로 재사용.
      - **산업분석/투자전략 수집 추가(오너 지시, 2026-09)**: "종목분석 옆에
        산업분석/투자전략 탭" 준비의 첫 단계 — 종목코드 없이 걸러지던 업종명
        리포트("반도체"·"유틸리티" 등 docTitle 자체가 업종명)와 정기 전략
        노트("대형주 추천종목"·"중소형주 추천종목"·"KB 리서치 모델
        포트폴리오"·"Global ESG Brief"·"KB IPO Brief")를 더 이상 버리지 않고
        `category:"산업"`으로 별도 수집한다(`docTitle`→`stockName`,
        `docTitleSub`→`title`, `symbol`은 항상 null). 라우트
        (`/api/cron/shinhan-research`)도 `category:"산업"`이면 이름 검색으로
        종목코드를 추측하지 않도록 수정(업종명이 우연히 어떤 회사명과 부분
        일치해 잘못 달라붙는 사고 방지). **미결**: 이 데이터를 화면에 어떤
        종목 페이지에 매칭해 보여줄지(업종 분류 체계 필요)는 아직 미정 —
        수집·저장까지만 우선 완료, 탭 UI·매칭 로직은 다음 과제. 다른 증권사
        (한경 컨센서스 "산업" 분류, DS증권 `sub03_03` 투자전략 게시판 등)도
        같은 방식으로 순차 확장 예정.
    - **KB증권 해외주식(미국 종목) 추가(오너 확인, 2026-09)**: 같은 내부
      TR(s040203010001)을 `tab=4`("해외주식")로 호출한다(오너가 화면 URL
      `go.able?linkcd=m04010004` 제시). 응답의 종목코드 필드는 ISIN이라
      제목 "AI 실적속보: 어도비 (ADBE US)"에서 티커를 뽑는다.
      `foldertemplate`로 시장이 구분돼(예: "해외 투자>해외투자>미국>미국
      전략") 미국만 고른다(중국/일본/인디아 등 제외). **로컬 스크립트**
      (`scripts/collect-kb-global-research.mjs`)가 같은 라우트를
      `source: "KB증권", market: "us"` 로 재사용.
      - **산업분석/투자전략 수집 추가(오너 지시, 2026-09 — "미국도
        산업분석을 하려면 역시 해외를 읽어라")**: "미국" 폴더 안에서도
        티커가 없는 항목("KB Global Tracker+"·"Global Insights"·"US Market
        Pulse" 등, docTitle=시리즈명·docTitleSub=헤드라인)을 지금까지
        통째로 버리고 있었다(실측: 미국 폴더 89건 중 63건). `category:"산업"`
        으로 별도 수집(symbol 항상 null, 목표주가·투자의견 추출은 건너뜀).
    - **한국투자증권 해외(미국 종목) 추가(오너 확인, 2026-09)**: 국내
      수집기와 같은 목록 페이지인데 분류만 다르다(`jkGubun=10` → `7`).
      한투 자체 리포트가 아니라 해외 증권사 리포트(스티펠·국태해통 등)를
      번역/중계한 것 — source 는 "한국투자증권"으로 두되 제목/요약은 원문
      그대로 쓴다. 제목이 "종목명(TICKER USA):제목" 형식이고 홍콩(HKG)
      등이 섞여 있어 USA만 고른다. PDF는 로그인이 필요해 상세 페이지
      URL을 대신 연결. **로컬 스크립트**
      (`scripts/collect-kis-global-research.mjs`)가 같은 라우트를
      `source: "한국투자증권", market: "us"` 로 재사용.
      - **산업분석/투자전략 수집 추가(오너 지시, 2026-09 — "미국도
        산업분석을 하려면 역시 해외를 읽어라")**: 목록 항목의 "head" 라벨이
        "스티펠 산업분석"·"국태해통증권 산업분석"처럼 "산업분석"으로 끝나는
        행은 종목이 아니라 업종 리포트("업종명:헤드라인" 형식)인데 지금까지
        통째로 버리고 있었다. `category:"산업"`으로 별도 수집(symbol 항상
        null, 목표주가·투자의견 추출은 건너뜀).
      - **미결(예외로 보류, 오너 지시, 2026-09)**: "HD, LOW 업데이트:
        밸류에이션 격차는 정당, 투자 전략 차이..."처럼 제목이 "종목명
        (TICKER USA):제목" 단일종목 패턴이 아니라 여러 종목(HD/LOW/UFPI/
        HAYW 등)을 한 번에 다루는 비교 노트는 TITLE_RE 에 안 걸려 종목
        없는 "산업"(예: "건자재")으로 떨어진다 — 실제로는 기업분석
        성격인데 스키마가 리포트당 종목 1개(symbol 단일값)만 지원해서
        생기는 구조적 한계. 고치려면 (a) 첫/대표 종목만 뽑아 단일종목
        기업분석으로 편입하거나 (b) 스키마를 멀티종목 지원으로 확장해야
        함 — 지금은 그대로 "산업"에 남겨두기로 보류(나중에 착수).
    - **GlobalMonitor(einfomax) 미국주식 리포트 추가(오너 확인, 2026-09)**:
      `globalmonitor.einfomax.co.kr` — 연합인포맥스가 운영하는 증권사 리서치
      통합 열람 서비스로, 키움·신한·유진·대신·한화·유안타·DB·현대차증권 등
      다수 증권사의 "미국주식" 분류 리포트를 한곳에 모아준다(한경 컨센서스가
      국내주식을 모아주는 것과 같은 성격, 3자 편집 서비스). 오너가 실제 화면
      URL(`ds_mobile_new.html#/USA/6/01`)을 제시해 발견 — AngularJS 레거시
      SPA라 내부 JS 번들에서 카테고리 코드(lscCd/sscCd, module_constants_base_
      bundle.js)와 실제 호출 파라미터(module_controller_m_bundle.js)를
      역추적해 확인. 로그인 없이 POST(`/bizrpt/reportlist`) 하나로 목록,
      PDF도 로그인 없이 바로 열림(`rreport.einfomax.co.kr/report/{secureId}.pdf`,
      확인됨). 제목이 "[종목명 (거래소:티커)] 제목" 형식이라 티커를 바로
      뽑는다(이름 검색 불필요) — 종목코드 없는 채권/경제/시황 리포트는 건너뜀.
      summary 필드에 정리된 한국어 요약 문단이 이미 있어 다른 소스보다 품질
      좋음. `globalmonitor.einfomax.co.kr` 은 robots.txt 자체가 없음(가장
      깨끗한 케이스). 이 소스로 리서치 기능이 **미국 종목까지 확장**됨
      (DB 스키마에 `market` 필드 추가, 기존 한국 전용 문서는 하위호환 처리).
      **로컬 스크립트** (`scripts/collect-globalmonitor-research.mjs`,
      GitHub Actions `.github/workflows/globalmonitor-research.yml`, 하루
      1회)가 같은 라우트를 `market: "us"` 로 재사용, 항목별 실제 작성
      증권사명(auth)을 `source` 로 그룹핑해 나눠 전송.
      - **산업분석/투자전략 수집 추가(오너 지시, 2026-09 — "한국과 미국 모두
        동일하게 수집 기반 구축", "해외는 GM에서 받아오는 회사는 제외")**:
        종목 티커 형식이 아닌 항목(채권/경제/시황 등, 예: "DB Morning
        Express", "[AI Economist] ...")을 예전엔 통째로 버렸는데, 실측
        결과(2026-09) 300건 중 175건이 이런 콘텐츠였다 — 이미 이 한 게시판에
        키움·한화·유안타·DB·대신·LS·SK·iM·상상인·하나증권 등 다수 증권사가
        다 모여 있어(auth 필드), `category:"산업"`으로 추가 수집하면 그
        증권사들 각자의 산업분석 게시판을 따로 안 붙여도 된다(오너 지시의
        "GM에서 받아오는 회사는 제외" 조건이 바로 이 의미). 제목이 "[라벨]
        헤드라인" 형식이면 대괄호를 라벨로, 아니면 라벨을 "산업"으로 고정.
        신한투자증권은 기존처럼 계속 제외(자체 해외 게시판이 이미 산업분석
        까지 다룸).
    - **DS투자증권 추가(오너 확인, 2026-09)**: `www.ds-sec.co.kr` 은 그누보드
      게시판이라 로그인 없이 서버렌더 HTML이 그대로 나온다(오너가 URL
      제시). 게시판 두 곳 — `sub03_02`(기업분석, 국내), `sub03_03`(투자전략/
      경제분석, 미국 종목이 섞여 있음). 종목 식별이 까다로운 소스라(제목에
      코드·티커가 아예 없음) 국내는 `corpcodes.json`(3,930개)에서 "제목이 그
      이름으로 시작하는 것 중 가장 긴 이름"을 찾고, 미국은 "[DS 미국주식]
      엔비디아: 제목"처럼 한글 종목명만 있어 네이버 해외종목 자동완성으로
      티커를 해석한다(뉴스 기능이 이미 쓰는 엔드포인트 재사용). **로컬
      스크립트** (`scripts/collect-ds-research.mjs`, GitHub Actions
      `.github/workflows/ds-research.yml`)가 같은 라우트를 `source: "DS투자
      증권"` 으로 재사용, 국내/미국을 market 별로 나눠 전송.
      - **산업리서치는 DS, 종목리서치(미국)는 GM(오너 결정, 2026-09)**:
        `sub03_03`은 게시판 이름 그대로 "투자전략/경제분석"이라 애초에
        종목보다 산업분석/투자전략 콘텐츠가 대다수다 — 종목명 매칭에 실패한
        (또는 애초에 종목 얘기가 아닌) 글을 `category:"산업"`으로 수집한다.
        "미국주식/글로벌주식" 태그가 있으면 market:"us", 그 외(국내 매크로·
        전략)는 market:"kr". `sub03_02`(국내 기업분석 게시판)도 종목 매칭에
        실패한 Defense Daily·거버넌스 시리즈·섹터 전략 노트 등을 같은 방식
        으로 `category:"산업"` 수집.
    - **BNK투자증권 추가(오너 확인, 2026-09)**: `www.bnkfn.co.kr` 리서치
      메뉴는 로그인 없이 평범한 GET으로 서버렌더 HTML이 그대로 나온다(지금
      까지 붙인 소스 중 구조가 가장 단순한 축). 제목이 "[종목명/투자의견]
      제목" 형식으로 고정돼 있어 종목명·투자의견을 함께 뽑는다. 종목코드는
      목록에 없어 라우트의 이름 검색(corpcode)에 맡긴다. PDF는 로그인 없이
      받아진다(`/uploads/{글번호}/1/{파일명}.pdf`). **로컬 스크립트**
      (`scripts/collect-bnk-research.mjs`, GitHub Actions
      `.github/workflows/bnk-research.yml`)가 같은 라우트를 `source: "BNK투자
      증권"` 으로 재사용.
      - **산업분석/투자전략 수집 추가(오너 지시, 2026-09 — "한국과 미국 모두
        동일하게 수집 기반 구축")**: 같은 사이트의 형제 게시판을 확인 —
        `analysingIssue.jspx`(업종분석, 제목이 기업분석과 똑같은 "[업종명]
        헤드라인" 형식이라 같은 정규식으로 파싱 가능), `economyAnalyse.jspx`
        (경제분석/투자전략, 대괄호 없는 평문 제목이라 라벨을 "산업"으로
        고정). 둘 다 `category:"산업"`, symbol 항상 null, 목표주가 추출도
        건너뜀.
    - **대신증권 — 제외(오너 결정, 2026-09)**: `www.daishin.com` 의 "기업분석"·
      "글로벌 기업분석" 메뉴가 둘 다 로그인 페이지로 리다이렉트되는 것만
      확인된 상태에서 오너가 진행 중단 결정. 재검토하지 않음.
    - **StockAnalysis.com 개별 애널리스트 투자의견 추가(오너 승인, 2026-09)**:
      Yahoo `upgradeDowngradeHistory` 는 증권사(firm)까지만 주고 애널리스트
      개인명·정확도는 유료 데이터라 안 나온다. stockanalysis.com 의 종목별
      Forecast 화면("Latest Forecasts")에는 애널리스트명·소속·등급·액션·
      목표주가(직전→현재)·별점·적중률이 다 들어있고, SvelteKit 사이트라
      HTML 파싱 없이 데이터 엔드포인트를 그대로 쓴다:
      `/stocks/{ticker}/forecast/__data.json?x-sveltekit-invalidated=001`
      (로그인 불필요, devalue 평탄화 배열이라 unflatten 필요, `ratings` 키에
      정확히 상위 5건). 위 정책 항목대로 robots.txt·ToS 모두 이 용도를 막지
      않는다 — 지금까지의 예외들(대부분 `Disallow: /`)보다 근거가 깨끗한 편.
      **로컬 스크립트** (`scripts/collect-analyst-forecasts.mjs`, GitHub
      Actions `.github/workflows/analyst-forecasts.yml`, 하루 1회)가 유니버스의
      미국 종목을 돌며 종목당 5건만 모아 `/api/cron/analyst-forecasts` 로 POST
      → MongoDB(`analyst_forecasts`). 종목 단위 **스냅샷 교체**(누적 아님 —
      5건에서 밀려난 옛 항목이 쌓이지 않게). 종목당 1요청·2초 간격.
      화면(`BrokerRatings`)은 "출처: StockAnalysis.com" 을 명시하고, 수집 전
      종목은 Yahoo 증권사 단위 표로 폴백한다. 앱 배포본은 DB 조회만
      (`/api/markets/us/[symbol]/analyst-forecasts`).
    - **로그인이 필요한 증권사는 이 프로젝트 방식 대상이 아님**: 실거래
      계좌 자격증명을 자동화 스크립트/CI 시크릿에 두는 것은 지금까지의
      "공개 페이지 개인용 크롤링" 예외와 성격이 전혀 다른(데이터센터 IP
      자동 로그인은 이상거래탐지·계정잠김 위험) 별개 문제라 진행하지 않음
      (오너가 실계좌 로그인 자동화를 요청했을 때 설명·거절한 사례 있음).
  - **예외 3건 (개인용, 오너 명시 승인, 2026-09)**: 거시경제 대시보드의 CNN
    Fear & Greed Index — `production.dataviz.cnn.io` 의 비공식 엔드포인트를
    `src/lib/macro/feargreed.ts` 가 호출한다(CNN 소유 지표, 공개 API 미제공).
    브라우저 User-Agent 위장 + `referer: https://www.cnn.com/` 헤더로 접근.
    감사 중 이 소스가 위 예외 목록에 문서화되지 않은 채 사용 중임이 드러나
    (2026-09) 오너가 개인용 조건으로 소급 승인. 다른 예외들과 동일 원칙 —
    실패 시 조용히 생략(해당 컴포넌트만 빠짐, 대시보드 전체 에러 아님) +
    딥링크(cnn.com/markets/fear-and-greed) 병행. 어댑터 격리(`lib/macro/`
    하위)도 이미 되어 있어 소스 교체 시 파일 단위로 영향 최소화.
- **산업분석 탭 (`/[market]/research`, 종목분석 옆 최상위 탭, 오너 지시
  2026-09)**: `kr_research` 의 `category:"산업"`(symbol 항상 null, 여러
  증권사가 이미 수집 중이었지만 종목별 조회(`getShinhanResearchBySymbol`)
  로는 화면에 전혀 노출되지 않던 데이터) 문서를 시장 전체용으로 보여준다
  (`getIndustryResearch()`, `/api/research/industry?market=&topic=`).
  **전체/산업분석/투자전략 세그먼트**(오너 지시)는 DB에 이 구분을 담는
  필드가 없어 `classifyResearchTopic()`이 stockName/title 키워드("전략",
  "추천종목", "포트폴리오" 등)로 화면단에서 후처리 분류한다 — 미래에셋
  market 분류와 동일한 트레이드오프, 완전하지 않음. **투자전략은 짧게만
  보관**(오너 지시 — "휘발성이 강해서 오래 가져갈 내용은 아니다", 원래 7일
  결정했으나 classifyResearchTopic() 분류 품질 검증 기간 동안 **30일로 임시
  상향**, 오너 지시 2026-09 — 검증 끝나면 7일로 되돌릴 것), 산업분석·
  기업분석은 기존 90일 유지 — `upsertShinhanResearch()`의 정리 단계에서
  "산업" 카테고리 중 (STRATEGY_MAX_AGE_MS)~90일 사이 문서만 후보로 가져와
  분류 후 투자전략인 것만 추가로 삭제. 수집기 백필 범위도 이 기간을 넘기지
  않는다(오너 지시 — "백필도 30일이다") — 그 이상 백필해도 다음 정리 때
  바로 지워지므로 실익이 없음.
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
