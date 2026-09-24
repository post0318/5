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
- Clerk (`@clerk/nextjs`) — 사용자 로그인·승인 대기제. 유니버스가 계정별로 분리됨

## 코드 구조

```
src/lib/server/app-auth.ts     Clerk 서버 검증 (requireAppUser / requireAdmin)
src/components/auth/           로그인 컨텍스트·게이트·가입 신청·계정 메뉴
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
src/lib/universe/repo.ts       유니버스 CRUD(계정별) + 일괄 파서 + 전 계정 합집합
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

## 인증 · 계정별 유니버스 (오너 지시 2026-09)

**공유 비밀번호(`APP_PASSWORD`) 로그인은 폐지**하고 4번 프로젝트
(`github.com/post0318/4`)에서 쓰던 **Clerk** 방식을 그대로 이식했다. 유니버스를
계정마다 따로 관리하려는 것이 목적이다 — A·B·C 가 각자 삼성전자를 자기 그룹명·
태그·메모로 담을 수 있다.

- **가입은 승인 대기제**(Clerk Waitlist) + **허용 도메인 검사**. 4번과 완전히
  같은 방식(오너 지시 2026-09): 허용 도메인 기본값 `hanwha.com` 이 **코드에
  박혀 있어**(`app-auth.ts` 의 `DEFAULT_ALLOWED_DOMAINS`) Vercel 에 아무것도
  넣지 않아도 검사가 돈다. 검사는 **가입 신청 화면에서 먼저** 걸러 안내하고
  (`signup-dialog.tsx` + `isAllowedEmail()`), 서버가 같은 값으로 한 번 더
  확인한다(`requireAppUser()`). 화면 쪽은 잘못된 주소로 신청해 승인 대기만
  쌓이는 걸 막는 안내용이고, 진짜 판단은 서버가 한다.
  `ALLOWED_EMAIL_DOMAINS` 로 덮어쓸 수 있고, 제한을 없애려면 빈 목록으로 둔다.
  화면이 쓸 도메인 목록은 `/api/auth/me` 응답의 `domains` 로 내려간다
  (로그아웃 상태에서도 부르는 이유가 이것).
- `ADMIN_EMAILS` 는 관리자 판정에만 쓴다 — 비워 두면 「기존 유니버스
  가져오기」가 아무에게도 안 보이므로 오너 이메일은 넣어야 한다.
- **가입 신청 팝업은 앱에 하나**(`SignupHost`). 헤더 계정 메뉴·유니버스 안내
  박스·Clerk 로그인 팝업의 "가입" 링크가 모두 같은 팝업을 연다. Clerk 의
  `waitlistUrl` 을 `/kr/universe?signup=1` 로 두고, `AppAuth` 가 그 쿼리를
  읽어 팝업을 연 뒤 주소에서 지운다(4번이 서버 searchParams 로 하던 것을
  클라이언트에서 대신).
- **잠금 위치**: 프록시(`src/proxy.ts`)는 Clerk 세션만 붙이고 아무것도 막지
  않는다. 실제 검증은 각 라우트에서 `requireAppUser()`
  (`src/lib/server/app-auth.ts`), 화면은 `AuthGate`(`components/auth/`)가
  안내만 한다. 4번과 같은 구조.
- **로그인 필수 화면 3곳**: 유니버스 통합 뷰 · 유니버스통합 뉴스 · 유니버스 관리.
  종목분석·산업분석·거시경제·주간 리포트 조회는 공개 유지(오너 결정). 종목분석의
  「유니버스에 추가」 버튼만 로그인 시 노출.
- **Clerk 키가 없으면 fail-closed** — 유니버스 라우트가 503, 화면은 안내 박스.
  나머지 앱은 그대로 돈다.

### 데이터 모델

- `universe_items` 유일 키 = **(ownerId, market, symbol)**. 옛 (market, symbol)
  유니크 인덱스는 `universeCol()` 이 기동 시 자동으로 걷어낸다 — 남아 있으면
  두 사람이 같은 종목을 담을 때 충돌한다.
- `universe_overview`(통합 뷰 캐시) 키는 **(market, symbol) 그대로 = 전 계정
  공유**. 시세·멀티플은 사람과 무관하므로 같은 종목을 열 사람이 담아도 외부 API
  호출은 한 번이다. 대신 이름·그룹명·태그·itemId 는 사람마다 다르므로 캐시에
  든 값을 믿지 않고 **조회 시점에 각 계정의 `universe_items` 값으로 덮어쓴다**
  (`getUniverseOverview()`). 캐시 삭제(`removeOverviewItem`)도 **다른 계정이
  아직 담고 있으면 건너뛴다**. 잔여 정리(`pruneOverview`)는 전 계정 합집합을
  넘겨야 안전해서 전 시장·전 계정 배치 경로에서만 부른다.
- **마이그레이션**: Clerk 도입 이전 문서는 `ownerId` 가 없어 어느 화면에도 안
  나온다. 관리 화면 상단 배너(관리자에게만 보임) → `/api/universe/claim-legacy`
  가 자기 계정으로 1회 귀속시킨다.

### 배치·수집 스크립트

- 수집 스크립트는 사람이 아니라 **세션을 가질 수 없다**. `/api/universe` 가
  로그인 필수가 되면서 `/api/cron/universe-symbols`(CRON_SECRET, 로컬 수동
  실행 시 `x-app-token: APP_PASSWORD`)를 새로 두고 **전 계정 합집합(중복 제거)**
  을 돌려준다. `scripts/collect-analyst-forecasts.mjs` 가 이 경로를 쓴다.
- `APP_PASSWORD` 는 이제 **사람 로그인용이 아니라 수집 스크립트 토큰 전용**이다
  (`.env.local` 에 `CRON_SECRET` 이 없어 로컬 수동 실행이 이 값에 의존).
  `/api/cron/*` 는 예전처럼 자체 검증하며 Clerk 과 무관하다.
- `listUniverseDistinct()` = 전 계정 합집합에서 (market, symbol) 중복 제거.
  배치는 반드시 이쪽을 쓴다 — 같은 종목을 사람 수만큼 반복 조회하지 않게.

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
  - **검증용 조회 예외 (오너 승인 2026-09-23, 2026-09-24 "1회" 제약 삭제)**: 재무 숫자
    정의·값 확인을 위해 MarketScreener·FnGuide 페이지를 **검증용으로만** 조회한다
    (사람이 보는 수준, 브라우저로 필요한 페이지만). 횟수 제한은 없다(오너 지시 2026-09-24
    — "검증용은 1회라는 제약을 제외한다. 검증용으로만 조회한다"). 용도는 검증에 한정 —
    앱·수집 스크립트 코드에는 넣지 않고, 화면에 싣거나 저장·수집하지 않는다. 처음 사례는
    EV·순차입금·우선주 시가총액 정의 대조, 이후 AVGO 순이익·EPS 대조(09-24).
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
        라우트 안전장치 재사용).
        - **버그 수정(2026-09)**: MA(시장) 분류는 "투자의견" 컬럼 자체가
          없어(헤더가 작성일/제목/작성자/제공출처 4칸뿐 — IN은 5칸) IN과
          같은 셀 인덱스로 읽으면 작성자·제공출처가 한 칸씩 밀려 뒤바뀐다
          (실측으로 발견 — MA 항목 전원의 제공출처가 빈 값으로 저장되고
          있었음). `parseIndustryItems`에 `reportCode`를 넘겨 MA/IN 컬럼
          수를 구분해서 읽도록 수정.
        - **국내·해외(market) 분류 추가(오너 지적, 2026-09 — "TSMC 얘기인데
          해외다")**: 지금까지 이 IN/MA 피드는 market 필드를 아예 안 보내
          라우트 기본값("kr")으로만 저장돼 TSMC·ECB 등 명백한 해외 콘텐츠도
          전부 국내로 잡히고 있었다. PDF 발췌(본문까지 포함, 제목만으론
          신호가 없는 경우가 많음 — 예: "AI 수요와 고도화..."는 본문에서야
          "TSMC"·"대만"이 나옴) 완료 후 `classifyIndustryMarket()`으로
          국내/해외 재분류, source별로 market까지 묶어 그룹핑해 라우트에
          나눠 전송(라우트가 POST 한 번당 market 하나만 받으므로).
        - **업종→종목(개별종목 승격) 매칭 추가(오너 지적, 2026-09 — 메리츠증권
          "HD현대중공업의 엔진 증설 발표..."가 종목 리포트인데 "산업"으로
          새고 있었음)**: 대괄호 업종 태그가 없는 제목만 DS투자증권 수집기와
          동일 방식("제목이 회사명으로 시작하는 것 중 가장 긴 이름",
          `corpcodes.json`)으로 매칭 시도, 맞으면 `category:"기업"`으로
          승격. 단순 `startsWith`는 "신흥국 실적 상향..."이 실제 상장사
          "신흥"(004080)의 접두어와 우연히 겹쳐 오매칭되는 문제가 실측돼(제목이
          자연어 문장이라 DS의 "[업종] 종목명 - 부제" 구조화 제목보다 충돌
          위험이 큼) 매칭 뒤 남는 글자가 없거나 공백/구두점/영숫자로
          이어지거나 한글 조사(의/은/는 등)로 끊기는 경우만 인정하도록 경계
          검사를 추가했다. **미결**: 해외 개별종목(예: 유진투자증권
          "플래닛랩스, 소버린 수요에 분기 최대 실적")은 이번 범위 밖 —
          네이버 자동완성 해석이 필요해 비용·오탐 위험이 더 크고, 국내
          매칭만으로도 확인된 사례 다수 해결돼 우선순위 낮춤(추후 과제).
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
        까지 다룸). **키움증권도 2026-09-24 추가 제외**(자체 수집기
        `collect-kiwoom-research.mjs` 신설 — "산업분석 탭" 항목의 "키움증권
        해외(미국) 산업/기업분석 추가" 참고, GM 경유 중복 방지).
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
      - **페이지네이션 버그 수정(오너 지적 2026-09-19 — "삼성전자 bnk
        리포트 빠진원인먼가?")**: 처음 만들 때부터 `?pageIndex=N` GET
        쿼리스트링으로 다음 페이지를 요청해왔는데, 서버가 이 파라미터를
        그냥 무시하고 **항상 1페이지만 돌려준다는 걸 뒤늦게 실측 확인**
        (page1과 "page2" 응답이 완전히 동일). 실제 목록 폼
        (`<form name="listFrm" method="post">`)은 페이지 링크의
        `onclick="fn_search('N')"`이 POST로 `curPage` 필드를 보내는
        방식이었다(실측 — POST `curPage=2` 로 실제 다른 목록 확인, 마지막
        페이지 476). 즉 이 수집기는 만든 이후 계속 최신 10여 건만
        반복 수집했고 그보다 오래된 리포트는 한 번도 못 가져왔다 — 그래서
        어떤 종목이 "최근에 안 다뤄졌는지"와 "가져오기 자체가 안 됐는지"가
        구분이 안 되는 상태였다. 수정 후 `--days=90 --pages=20` 재수집으로
        실측 확인: 이전엔 사실상 10~30건 수준이던 게 **128건**으로 늘어남
        (기업분석 92건 + 업종분석·경제분석 합산). 삼성전자는 이 90일치에도
        없음 — 이 브로커가 실제로 최근 삼성전자를 다루지 않았다는 뜻(버그
        아님, 실측 확인).
      - **relatedSymbols — 산업분석의 대형주 언급을 종목 페이지에 연결
        (오너 지시 2026-09-19, "bnk만 해보고 결정하자")**: 위 페이지네이션
        버그를 고치다가 BNK "반도체" 업종분석 PDF가 삼성전자를 26번 언급
        하는데도 삼성전자 페이지엔 전혀 안 뜨는 걸 발견 — `category:"산업"`
        문서는 라우트가 이름 검색을 건너뛰어 `symbol` 이 항상 null이라
        종목별 조회(`getShinhanResearchBySymbol`)에 안 걸리기 때문(설계상
        의도된 동작, 버그 아님). PDF 본문을 이미 열어보는 김에(목표주가
        추출과 같은 시점) 미리 정한 대형주 29종목 이름의 언급 횟수를 세어
        3회 이상이면 그 종목코드를 `relatedSymbols: string[]` 로 태깅한다
        (`analyzePdf()`, PDF 원문은 여전히 저장 안 함 — 횟수 판정 결과만
        남음). 조회는 `{ $or: [{ symbol }, { relatedSymbols: symbol }] }`
        로 확장. 오너 확인 질문("삼성전자와 sk하이닉스가 각 10번씩
        언급되었네? 그러면 둘다 나오나?")대로 배열이라 종목 하나의 리포트가
        여러 종목에 동시에 걸릴 수 있음. 화면(`ShinhanResearch`)은 이렇게
        끼어든 산업분석 항목 앞에 `[업종명]` 을 붙여 왜 나왔는지 표시.
        실측: 90일 재수집 128건 중 5건에 태깅됨. **BNK 전용으로 우선
        구현**(오너 지시 — 다른 수집기 확대는 BNK 결과를 보고 추후 결정).
    - **상상인증권 추가(오너 확인, 2026-09)**: `www.sangsanginib.com` 화면은
      목록을 AJAX로 채워 HTML만 받아서는 아무것도 안 나온다. 브라우저
      네트워크 로그로 내부 API를 역추적: `POST /notice/getNoticeList`
      (form-urlencoded, `cmsCd`로 게시판 구분·`rowNum`·`startRow`·`src=all`·
      `sdt`/`edt`). 응답에 STOCK_CD(종목코드)·STOCK_NM·TITLE·REGDT·NM(작성자)
      이 구조화돼 있어 제목 파싱도 이름 검색도 불필요. 기업리포트
      (`cmsCd=CM0079`, 로컬 스크립트 `scripts/collect-sangsangin-research.mjs`,
      GitHub Actions `sangsangin-research.yml`)가 먼저 붙었고, 전체 4,466건
      (실측)으로 한경 컨센서스 경유분(90일 12건)보다 훨씬 많아 자체 수집으로
      전환(오너 — "사이트에는 리서치가 엄청 많다"). PDF는 로그인 없이
      규칙적인 경로(`/_upload/attFile/{cmsCd}/{cmsCd}_{NT_NO}_1.pdf`)로
      받아진다.
      - **산업리포트/주식시장 수집 추가(오너 지적, 2026-09 — "산업리포트가
        버젓이 공개하는데" + "투자전략도 있고")**: 같은 내부 API를 다른
        `cmsCd`로 재사용 — 화면(`research/industryReport/industryReportView`,
        `research/stockMarket/stockMarketView`)이 로드하는 정적 JS 번들
        (`/static/js/research/{보드}/{보드}.js`)에서 `cmsCd` 값을
        역추적해 확인: 산업리포트 `CM0338`(868건, STOCK_NM에 이미 깔끔한
        업종명이 있어 그대로 씀), 주식시장 `CM0078`(2,532건, STOCK_NM이
        전부 "시장전체"로 안 나뉘어 있어 제목의 "[라벨] 헤드라인" 브라켓을
        라벨로 뽑음 — "상상인 US Monitor"처럼 이미 `classifyResearchTopic()`
        의 `MARKET_CONDITION_STOCKNAMES`에 있던 라벨과 그대로 일치).
        `category:"산업"`, symbol 항상 null, 목표주가·투자의견 추출도
        건너뜀. market은 두 게시판 모두 국내(한국어) 관점 코멘터리라 "kr"
        고정(미국 자산 얘기도 상상인 리서치센터가 작성한 해외 시황 코멘트라
        신한 M.R.I 등 다른 브로커의 국내 "투자전략" 게시판과 동일 처리).
        **로컬 스크립트** (`scripts/collect-sangsangin-industry-research.mjs`,
        GitHub Actions `sangsangin-industry-research.yml`)가 같은 라우트를
        `source: "상상인증권"` 으로 재사용.
    - **해외 IB/자산운용사 리서치 5곳 추가(오너 지시, 2026-09-19)**: 오너가
      골드만삭스·JP모간·모간스탠리·블랙록·PIMCO 5곳의 공개 인사이트 페이지를
      제시하며 산업분석/기업분석 코퍼스 보강을 요청, **5곳 모두 구축 완료**.
      이 프로젝트에서 영문 원문을 그대로 쓰는(번역 안 함) 첫 비한국계 소스
      군이다 — 종목 얘기가 아닌 매크로/업종 테마 콘텐츠라 5곳 다
      `category:"산업"`(symbol 항상 null), `market:"us"`, `stockName:"글로벌
      인사이트"`(블랙록만 "글로벌 위클리 시황").
      - **robots.txt 관련 특이사항**: 골드만삭스는 `User-agent: *` 규칙으로는
        `/insights/top-of-mind/` 를 막지 않지만, `GPTBot`/`ChatGPT-User`
        AI 크롤러 전용 규칙에서는 정확히 이 경로를 명시적으로 차단하고
        있음(오너가 제시한 바로 그 페이지) — 지금까지의 예외들과 달리 "AI가
        긁어가는 건 원치 않는다"는 의도가 코드로 명시된 첫 사례. 오너에게
        플래그했고 "5곳 모두 동일 조건으로 진행"(일반 UA 기준 판단, AI 전용
        규칙 무시)으로 명시 결정.
      - **핵심 발견 — 목록 페이지 대신 사이트맵을 쓴다**: 오너가 제시한 목록
        페이지(골드만삭스 `/insights/goldman-sachs-research`, JP모간
        `/insights/global-research`, 모간스탠리 `/insights/topics/investing`)
        는 전부 실제 기사 카드가 검색 위젯(골드만삭스 Algolia — 앱ID·검색키는
        페이지에 노출되나 인덱스명을 못 찾음)이나 JS 지연 로드 뒤에 있어
        정적 fetch로는 목록을 못 뽑는다(실측 — 목록형 페이지 자체에 기사
        링크가 사실상 1개뿐). 대신 **`robots.txt`에 명시된 공개
        `sitemap.xml`에 개별 인사이트 글 URL이 `<lastmod>`와 함께 전부
        들어있어**(실측 — 4곳 다 최신 항목이 전날 발행분까지 잡힘, 신한/하나
        같은 "게시판 목록 API" 대신 처음 쓴 "사이트맵 diff" 방식) 이걸로
        최근 글 목록을 얻고, 개별 글 페이지는 서버렌더 HTML이라 제목·요약·
        날짜를 `<meta>` 태그에서 바로 뽑는다. PIMCO만 소사이트맵 자체가
        국가별로 나뉨(`/sitemap_index.xml` → `/us/en/sitemap.xml`), 나머지
        3곳은 골드만삭스·모간스탠리가 단일/거의-단일 사이트맵, JP모간은
        국가별로 나뉨(`/US/en/sitemap.xml`).
      - **사이트마다 발행일 메타 필드가 전부 다름**(실측, 5곳 비교): 블랙록
        `<meta name="publicationDate">`("Sep 14, 2026"), 골드만삭스 JSON-LD
        `"datePublished"`(ISO), JP모간 `<meta name="publishDate">`
        ("September 15, 2026" — 사이트맵 lastmod과 다를 수 있음, lastmod은
        편집일·publishDate가 실제 발행일), 모간스탠리 `<meta name="content_
        publishedAt">`(ISO), PIMCO는 본문에 발행일 메타 자체가 없어 **사이트맵
        lastmod을 그대로 씀**(이 사이트는 lastmod이 날짜 단위로 기사마다
        세밀히 찍혀 있어 사실상 발행일과 같음, 실측 확인). 표준 og:title도
        사이트마다 접미사가 다르거나(JP모간 `<title>`은 " | J.P. Morgan",
        모간스탠리·PIMCO는 og:title 자체에 접미사) 아예 없어(JP모간은
        og:title 자체가 없어 `<h1>`을 씀) 소스별로 별도 정리 필요했음.
      - **요약 품질도 사이트마다 다름**: 모간스탠리·PIMCO는 `og:description`에
        이미 다듬어진 1~2문장 요약이 있어 그대로 씀(품질 좋음). JP모간은
        `<meta name="description">`에 비슷한 품질의 요약이 있음. 골드만삭스는
        메타 요약이 title과 동일(무의미)해 본문 첫 문단을 발췌하는데, 페이지에
        숨겨진 메가메뉴 nav 텍스트("What We Do"/"Insights"/"Our Firm"/
        "Careers"로 시작하는 문단들)가 실제 본문보다 먼저 나와 이 프리픽스로
        걸러낸다(`NAV_JUNK_RE`, 실측 — 필터 없이 쓰면 nav 텍스트가 그대로
        요약으로 저장됨). 팟캐스트형 Top of Mind 일부는 본문이 "Subscribe:
        ..." 같은 UI 텍스트뿐이라 필터를 통과할 실제 문장이 없으면 빈 요약으로
        폴백(정크 텍스트를 저장하는 것보다 나음 — 우선순위 낮아 개선 보류).
      - **블랙록(BII) 위클리 시황**: 다른 4곳과 다르게 "게시판/사이트맵"이
        아니라 `blackrock.com/sg/en/insights/global-weekly-commentary` 라는
        **URL이 고정이고 내용만 매주 교체**되는 단일 페이지(실측 확인,
        페이지네이션 없음). `<meta name="articleTitle">`·`<meta
        name="pageSummary">`·`<meta name="publicationDate">` 세 값만으로
        제목·요약·발행일이 다 나와 PDF·API 역추적이 불필요한 가장 단순한
        케이스. 매주 내용이 바뀌므로 `id`를 발행일 기반
        (`weekly-commentary-YYYY-MM-DD`)으로 만들어 과거분이 안 덮어써지게
        함.
      - **로컬 스크립트 4개**: `scripts/collect-blackrock-research.mjs`
        (`source:"BlackRock"`, GitHub Actions 하루 1회 — 주 1회만 바뀌는
        콘텐츠라 대부분은 같은 문서 재확인에 그침), `scripts/collect-
        goldman-research.mjs`(`source:"Goldman Sachs"`), `scripts/collect-
        jpmorgan-research.mjs`(`source:"J.P. Morgan"`), `scripts/collect-
        morganstanley-research.mjs`(`source:"Morgan Stanley"`), `scripts/
        collect-pimco-research.mjs`(`source:"PIMCO"`) — 전부 같은
        `/api/cron/shinhan-research` 라우트 재사용, GitHub Actions 하루
        1회(`.github/workflows/{blackrock,goldman,jpmorgan,morganstanley,
        pimco}-research.yml`, 실행 시각을 5분씩 밀려 동시 실행 줄임).
      - **노출 한계(실측 확인, 2026-09-19)**: 5곳 다 실제 업서트는 성공했지만,
        미국 시장 `category:"산업"` 문서가 다른 15곳 넘는 국내 수집기
        (GlobalMonitor·KB·NH·신한 등)에서 이미 하루 150건 넘게 쏟아지고 있어
        `/api/research/industry` 조회의 `fetchLimit`(900)·`limit`(150, 날짜
        내림차순) 안에서 저빈도 소스(특히 블랙록 주 1회)는 며칠만 지나도
        밀려날 수 있음(실측 — 블랙록 발행 5일 뒤 조회 시 이미 안 보임). 데이터
        유실이 아니라 고빈도 소스들 사이에서 저빈도 소스가 화면 노출 순위에서
        밀리는 기존에 이미 알려진 트레이드오프(CLAUDE.md 위 "산업분석 탭"
        항목 참고) — 별도 수정 없이 그대로 둠.
      - **로컬 실행 인증 관련 별개 발견 및 수정(2026-09-19)**: 작업 중
        `.env.local`의 `CRON_SECRET` 값이 `vercel env pull` 류 작업으로
        `"[SENSITIVE]"` 마스킹 placeholder 로 바뀌어 있는 걸 발견 — 로컬
        수집 스크립트는 전부 "CRON_SECRET 있으면 우선, 없으면 APP_PASSWORD"
        순서라 이 상태에서는 모든 로컬 수동 실행이 401로 실패한다
        (`APP_PASSWORD` 는 정상이었음). 블랙록 백필은 x-app-token 으로 직접
        우회해 완료했고, 이후 오너 확인 하에 `.env.local`에서 마스킹된
        `CRON_SECRET` 줄 자체를 삭제해 원래 문서화된 상태(로컬엔
        CRON_SECRET 없음 → APP_PASSWORD 폴백)로 복원함 — 이후 골드만삭스/
        JP모간/모간스탠리/PIMCO 백필부터는 정상 폴백으로 진행.
    - **키움증권 해외(미국) 산업/기업분석 추가(오너 확인, 2026-09-24)**: 오너가
      제시한 `www3.kiwoom.com/h/invest/research/VAnalCCView`·
      `www.kiwoom.com/h/invest/research/VAnalCCDetailView?sqno=` 는 실제
      콘텐츠로 안내만 하고, 진짜 데이터는 서브도메인 `bbn.kiwoom.com`의
      내부 JSON AJAX에서 온다(`fn_list`/`fn_detail` 역추적) — 목록
      `POST /research/SResearchCCListAjax`(15건 고정), PDF는
      `GET /research/SPdfFileView?rMenuGb=CC&attaFile=...&makeDt=...`.
      **로그인 없이 PDF까지 그대로 받아진다**(실측: `Content-Type:
      application/pdf` 200) — 지금까지 대부분의 국내 증권사(신한·하나·
      한국투자·교보 등)가 PDF에 로그인을 요구하던 것과 다른 몇 안 되는
      예외. `www3`·`bbn` 모두 robots.txt 가 `Allow: /`(제한 없음, 가장
      깨끗한 케이스). 제목이 "종목명(TICKER.US): 헤드라인" 형식(종목명과
      괄호 사이 공백 유무가 섞여 있어 정규식에 `\s*` 허용)이라 이름 검색
      불필요. **로그인 없이 PDF를 받을 수 있는 몇 안 되는 소스**라 공용
      추출기(`us-research-extract.mjs`)의 PDF 보강 단계(`usePdf:true`)를
      켜서 목표주가를 채운다(실측 백필 4/4 성공) — 투자의견은 PDF 안에서
      그래픽 배지로 표시돼 텍스트로 못 뽑음(실측 확인, 버그 아님). 종목
      티커 패턴이 아닌 항목("[미국은 지금] ...", "09/21 큠틴 아메리카
      (미국주식 Weekly)" 등)은 `category:"산업"`으로 별도 수집(symbol 항상
      null).
      - **국내·AI보고서·글로벌테마 게시판 추가(오너 지시, 2026-09-24 —
        "기업분석 산업분석 스팟노트", "이슈분석은 제외한다", "키움 해외
        ai보고서는 종목분석에 해당된다", "키움 해외 글로벌테마/이슈는
        투자전략(이슈)로 분류하고 키차트는 연결대상에서 제외한다", "채권
        시장이슈는 수집대상에서 제외한다")**: `rMenuGb` 2글자 게시판 코드는
        화면 어디에도 노출되지 않아 후보 코드를 하나씩 찔러 응답의
        `rMenuGbNm` 필드로 확인했다(실측). 최종 화이트리스트 —
        `AI`(AI 보고서, market:"us", category:"기업" — 제목이 "[AI 실적
        리뷰] {분기} 종목명 (TICKER.US)" 형식으로 콜론 없이 끝에 티커가
        옴), `CA`(글로벌 테마/이슈분석, market:"us", category:"산업",
        라벨을 "투자전략(이슈)"로 고정하되 제목에 "키차트"가 들어간 항목은
        단순 주간 차트라 제외 — "키움 글로벌 키차트(9월 3주)"류는 버리고
        "키움 글로벌 9월 Monthly - 줄다리기"류만 남음, 실측 45일 기준
        수십 건 중 1건만 통과), `CR`(기업리포트, market:"kr",
        category:"기업", "종목명(6자리코드): 제목" — 코드가 바로 나와
        이름 검색 불필요, 콜론 대신 세미콜론을 쓰는 오탈자성 항목도
        실측돼 `[:;：]`로 허용), `SN`(스팟노트, market:"kr", CR과 같은
        제목 형식이지만 더 짧은 코멘트성 리포트라 별도 게시판),
        `CI`(산업분석, market:"kr", category:"산업", 대괄호/콜론 라벨
        추출 — 삼성증권 수집기와 같은 로직이라 공용
        `lib/label-extract.mjs`로 뺐다, 삼성증권도 이걸 쓰도록 리팩터).
        **화이트리스트 방식이라 뺀 게시판은 그냥 안 부르면 그만**(별도
        차단 로직 불필요) — `CS`(이슈분석, 국내), `QE`(퀀트전략),
        `SW`(주간증시전망), `SE`(경제분석), `BM`/`BW`(월간·주간채권전망,
        "채권시장이슈" 제외 지시에 해당), `CH`(중화권), `CJ`(일본),
        `TP`(글로벌 ETF — 넣었어도 ETF 필터에 걸림), `EM`(월간증시전망),
        `BC`(디지털자산리서치). 국내(market:"kr") 항목은 공용 추출기
        (`us-research-extract.mjs`)가 달러 표기 기준이라 PDF 보강을 하지
        않음(투자의견·목표주가 공란, 다른 국내 수집기들과 동일) — 미국
        항목만 PDF 보강 대상.
      **로컬 스크립트** (`scripts/collect-kiwoom-research.mjs`,
      GitHub Actions `.github/workflows/kiwoom-research.yml`, 하루 3회 —
      3차는 2차 4시간 뒤, 오너 지시 2026-09-24)가
      같은 `/api/cron/shinhan-research` 라우트를 `source: "키움증권"`로
      재사용, 시장별(`market: "us"`/`"kr"`)로 나눠 전송. **GlobalMonitor
      경유 중복 제외(오너 지시
      2026-09-24 — "글로벌모니터에서 수집건 중 개별 증권사에서 수집된
      동일한 문서는 제외해야한다")**: GlobalMonitor 응답의 `auth` 필드에
      "키움증권"이 실제로 섞여 나오는 걸 확인해(자체 수집기가 더 안정적이고
      PDF까지 확보되므로) `collect-globalmonitor-research.mjs`의
      `EXCLUDED_SOURCES`에 추가 — 신한투자증권과 동일 처리(아래 "GlobalMonitor
      미국주식 리포트" 항목 참고). **미결**: 이미 GM 경유로 쌓인 옛
      `키움증권:GM:*` 문서는 DELETE(`source:"키움증권", idPrefix:"GM:"`)로
      아직 안 지웠다 — 다음 배포 후 정리 필요(idPrefix를 꼭 줘야 새로 쌓이는
      자체 수집기 문서(`키움증권:{sqno}`, GM: 접두어 없음)까지 같이 안 지워짐).
      삼성증권은 이번 실측(USA 목록 샘플)에서 GlobalMonitor `auth`에 안 잡혀
      제외 목록에 추가하지 않음(중복 위험 없음, 확인됨).
    - **거시경제 "이슈분석"/"환율분석" 탭 신설(오너 지시, 2026-09-24)**:
      `/macro`가 세 개 하위 탭(글로벌핵심지표·이슈분석·환율분석)으로
      확장됐다 — 이슈분석·환율분석은 종목·시장(kr/us/jp)에 안 매이는 매크로
      코멘트라 "전체/증권사명"으로 구분(오너 지시 — "전체/증권사명 으로
      해서 증권사별로 구분한다")한다. `kr_research`(종목·산업분석용)와는
      완전히 별개 컬렉션(`macro_issues`)·라우트(`/api/cron/macro-issues`,
      `/api/research/macro-issues`)·수집기(`collect-kiwoom-macro-issues.mjs`)로
      새로 뺐다(오너 결정 — "새 전용 수집"). 시작은 키움증권만("다른
      증권사는 추후 동일한 방식으로 하나씩 추가").
      - **환율분석**: 게시판 코드 `FE`(rMenuGbNm "일간환율전망", "09/23
        달러, 강보합권 등락" 같은 데일리 환율 코멘트, 오너 지시 — "키움증권은
        환율전망이 대상이 된다").
      - **이슈분석 — 게시판 코드 확정에 두 번 헤맴(오너 지적으로 정정,
        2026-09-24)**: 키움 사이트엔 `rMenuGbNm`이 똑같이 "이슈분석"으로
        나오는 게시판이 **세 개**나 있다(브루트포스로 2글자 코드를 하나씩
        찔러 이름만으로 찾다 보니 발생) — `CS`("기업/산업분석" 메뉴 하위,
        실제 내용은 "키움리서치 관심종목(N월 N주)" 반복 시리즈, 오너 지시로
        처음부터 제외 대상), `IA`(내용 자체는 그럴듯한 거시 이슈 분석이지만
        실제 사이트 내비와 연결된 게 아니었음 — 처음에 이걸 골랐다가
        오너가 실제 화면 스크린샷("투자정보 > 리서치 > 경제/전략 >
        이슈분석")을 보내 "왜 다르지?"라고 지적해 오답으로 판명), **`SI`**
        (스크린샷 내용과 제목·날짜까지 정확히 일치 확인, 최종 정답 — "경제
        전략의 이슈분석은 가져와야한다"). **교훈**: `rMenuGbNm` 같은 서버
        내부 라벨만으로는 실제 사이트 내비게이션과 매칭되는 게시판을
        확정할 수 없다 — 브루트포스로 게시판 코드를 찾을 때는 실제 화면
        스크린샷으로 오너 확인을 받는 게 안전하다(이번엔 그 확인 없이
        진행했다가 한 번 틀림).
    - **삼성증권 해외기업/해외산업 추가(오너 확인, 2026-09-24)**: 오너가 제시한
      POP(`www.samsungpop.com`) "투자정보 > 해외주식 > 해외주식투자정보" 화면은
      레거시 frameset + XCMS 메뉴 시스템(메뉴코드 → URL 매핑이 서버 세션에서
      동적으로 채워짐, NH·미래에셋과 같은 구조)이라 메뉴코드로 콘텐츠 URL을
      끝내 못 찾았다 — 대신 **모바일 리포트 검색 화면**
      (`/mbw/invest/investInfo.do?cmd=report_search`)이 훨씬 단순한
      서버렌더 HTML이라 그 검색 폼(`GET /mbw/search/search.do?
      cmd=report_search&GUBUN=...`)을 그대로 호출한다. `GUBUN=company2`
      (해외기업)·`industry2`(해외산업) 두 구분을 돈다(화면의 "리포트 구분"
      드롭다운에 16개 구분이 더 있어 국내 기업/산업/투자전략 등으로 확장
      여지 있음). **PDF는 로그인 없이 받아진다**(실측 확인, 오늘 날짜 파일도
      200) — 모바일 화면의 `downloadPdf()` 함수 자체는 "로그인 후 이용
      가능합니다" 확인창을 띄우는 로그인 게이트 UI지만, 그 함수가 넘겨받는
      `fileName` 값을 레거시 다운로드 엔드포인트(`common.do?cmd=down&
      saveKey=research.pdf&fileName=...`)에 직접 넣으면 그대로 열린다 — UI만
      로그인을 요구할 뿐 엔드포인트 자체는 열려 있는 패턴(다른 소스에서도
      나온 사례). `www.samsungpop.com/robots.txt` 는 `Allow: /`(제한 없음,
      가장 깨끗한 케이스). 제목이 "(작성자) 종목명 (TICKER US): 헤드라인"
      형식(다른 증권사의 "TICKER.US"와 달리 마침표 없이 공백으로 구분)이라
      그 패턴에서 티커를 뽑고, 공용 추출기(`us-research-extract.mjs`)가
      로그인 없이 PDF 본문까지 확인해 목표주가를 채운다(실측 확인 —
      투자의견은 다른 소스처럼 PDF 안에서 텍스트로 안 잡히는 경우가 많음).
      티커 패턴이 아닌 항목(예: "글로벌 포트폴리오 전략(9월 4주 차)...",
      "글로벌 AI/SW: ...")은 `category:"산업"`으로 별도 수집(symbol 항상
      null). **로컬 스크립트** (`scripts/collect-samsung-research.mjs`,
      GitHub Actions `.github/workflows/samsung-research.yml`, 하루 2회)가
      같은 `/api/cron/shinhan-research` 라우트를 `source: "삼성증권",
      market: "us"` 로 재사용.
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
  - **예외 4건 (개인용, 오너 명시 승인, 2026-09-19)**: 거시경제 대시보드의
    Fed 금리 확률 카드 — Kalshi 예측시장 API(`api.elections.kalshi.com/
    trade-api/v2`, 무인증 공개)를 `src/lib/macro/fedwatch.ts` 가 호출한다.
    - **원래 목표는 CME FedWatch** 였으나 두 경로 모두 막혔다. ① FedWatch
      수치를 직접 계산하려면 연방기금금리 선물의 **월물별 시세가 필요한데
      이건 CME 유료 데이터**라 우리에게 없다. ② CME 공식 FedWatch 도구
      페이지와 investing.com 의 동일 위젯은 **스크래핑·iframe 임베드가 모두
      차단**돼 있다(응답 헤더 `X-Frame-Options`/`Content-Security-Policy:
      frame-ancestors` 실측 확인) — 화면에 끼워 넣는 것 자체가 불가능.
    - **대안으로 Kalshi 선택(오너 결정)**: CFTC 규제를 받는 미국 예측시장
      으로, `KXFED` 시리즈가 FOMC 회의별 "연방기금금리 **상단이 X% 초과**?"
      계약을 25bp 간격으로 제공한다. 인증·API 키 없이 열리고, 누적 확률을
      인접 임계값끼리 빼면 목표범위 구간별 확률이 나와 FedWatch 와 같은
      형태(인상/동결/인하)로 재구성된다.
    - **ToS 긴장(다른 예외들과 성격이 다름 — robots.txt 가 아니라 명시적
      약관 조항)**: Kalshi Data Terms of Service 는 데이터 사용을
      "personal, non-commercial" 로 제한하고 **서면 동의 없이 제3자에게
      공유·게시하는 것을 금지**한다. 이 앱의 거시경제 대시보드는 로그인
      없이 공개(오너 결정 — 종목분석·거시경제는 공개 유지)라 그 조항과
      정면으로 충돌할 소지가 있다. 오너가 이 위험을 설명받은 뒤 **"허가
      없이 그냥 진행한다"** 고 명시 결정 — Kalshi 에 서면 동의를 구하지
      않는다. 개인용 전제 + 출처 표기("출처: Kalshi") + 딥링크
      (`kalshi.com/markets/kxfed/fed-funds-rate`) 병행으로 진행.
    - 다른 예외들과 동일 원칙 — 실패 시 조용히 생략(`null` 반환, 카드만
      빠지고 대시보드 전체는 정상), 어댑터 격리(`lib/macro/` 하위)로 소스
      교체 시 파일 단위 영향.
    - **유지보수 주의**: 인상/동결/인하 분류는 "현재 목표범위" 를 알아야
      계산되는데 Kalshi 응답엔 그 값이 없어 `CURRENT_FED_RANGE_LOW` 상수
      (현재 3.75 = 3.75~4.00%, 2026-09-16 FOMC 결정)로 코드에 박아 뒀다.
      **FOMC 결정이 날 때마다 손으로 갱신해야 한다** — 틀리면 세 숫자가
      통째로 한 칸씩 밀린다. `lib/weekly/comment.ts` 의 `FOMC_2026`·
      `BOJ_2026` 일정 배열과 같은 수동 갱신 패턴.
- **ETF/ETP 리포트는 전 수집기 공통 제외 대상(오너 지시 2026-09-24 —
  "ETF, ETP 등은 수집대상에서 제외한다. 여기뿐만 아니라 모두 동일하다")**:
  이 프로젝트의 산업분석/투자전략 수집은 개별 종목·업종 얘기가 목적인데,
  ETF/ETP 리포트는 종목이 아니라 상품(펀드 자금 흐름·구성비 등) 얘기라
  범위 밖. 소스마다 각자 키워드를 두지 않고 `scripts/lib/exclude-filters.mjs`
  의 `isEtfOrEtpContent()` 한 곳에서 관리 — 나중에 예외 패턴이 하나 발견되면
  전체 수집기에 한 번에 반영된다. 발견 계기는 삼성증권 수집기의 "산업" 분류
  라벨 정리 중(예: "ETP Weekly Insight", "모두의 ETP Biweekly", "[ETF전략]
  오토콜러블...") — 삼성증권·키움증권·GlobalMonitor 수집기에 이미 적용
  완료(2026-09-24). **미결**: 그 이전에 만든 나머지 수집기들(신한·하나·
  NH·KB·한투·DS·BNK·상상인·해외 IB 등)은 아직 이 필터를 안 쓴다 — 실제로
  ETF/ETP 콘텐츠가 섞이는 게 확인되면 그때그때 같은 필터를 추가할 것(전량
  일괄 적용은 보류, 근거 없이 손대지 않음).
- **산업분석 탭 (`/[market]/research`, 종목분석 옆 최상위 탭, 오너 지시
  2026-09)**: `kr_research` 의 `category:"산업"`(symbol 항상 null, 여러
  증권사가 이미 수집 중이었지만 종목별 조회(`getShinhanResearchBySymbol`)
  로는 화면에 전혀 노출되지 않던 데이터) 문서를 시장 전체용으로 보여준다
  (`getIndustryResearch()`, `/api/research/industry?market=&topic=`).
  **전체/산업분석/투자전략(주식)/투자전략(채권)/시황 세그먼트**(오너
  지시 — 투자전략을 주식/채권으로, 시황을 별도로 추가 분리)는 DB에 이
  구분을 담는 필드가 없어 `classifyResearchTopic()`이 stockName/title(+일부
  키워드는 summary까지) 키워드로 화면단에서 후처리 분류한다 — 미래에셋
  market 분류와 동일한 트레이드오프, 완전하지 않음(상세 규칙·우선순위는
  `src/lib/db/shinhan-research.ts`의 `classifyResearchTopic()` 주석 참고).
  **투자전략·시황은 짧게만 보관**(오너 지시 — "휘발성이 강해서 오래
  가져갈 내용은 아니다") — 투자전략(주식)/(채권)은 원래 7일 결정했으나
  분류 품질 검증 기간 동안 **30일로 상향, 이게 최종 값**(오너 지시,
  2026-09 — "그 이상은 불필요하다. 화면에서도 제외한다", 7일로 되돌릴
  계획 없음). 시황은 원래 7일 지시("시황은 7일 이상은 불필요하다")였다가
  분류 검증 기간 동안 **14일로 임시 상향**(오너 지시 — "일단 14일까지
  유지한다... 테스트가 필요하니") — **시황만** 검증 끝나면 7일로 되돌릴
  것. 산업분석·기업분석은 기존 90일 유지 — `upsertShinhanResearch()`의
  정리 단계에서 "산업" 카테고리 중 (시황 14일 컷오프)~90일 사이 문서만
  후보로 가져와 분류 후 각자의 컷오프(투자전략 30일/시황은 후보 자체가
  이미 14일 이전)를 넘긴 것만 추가로 삭제, `getIndustryResearch()` 조회
  시점에도 같은 컷오프를 한 번 더 적용(다음 수집기 실행 전까지 화면에
  남는 것 방지). 수집기 백필 범위도 이 기간을 넘기지 않는다(오너 지시 —
  "백필도 30일이다") — 그 이상 백필해도 다음 정리 때 바로 지워지므로
  실익이 없음.
  - **classifyResearchTopic() 구조적 개편(오너 지적 다수, 2026-09 — "단순히
    위클리만 따라가면 답없다" + "내용을 보면 주식과 채권인지 구분이
    안되냐?")**: "위클리/데일리" 등 주기성 키워드와 "금리/고용/물가" 등
    약한 매크로 키워드를 stockName 이 실제 업종명(하나증권 "철강금속
    Weekly"/"Battery Weekly", IBK "IBKS Daily" 등 정기 업종 커버리지)일
    때는 신뢰하지 않도록 분리(`isGenericOrBoardLabel()`) — 이전엔 이
    키워드들이 있으면 무조건 시황/투자전략(채권)으로 넘어가 90일치 중
    100건 이상이 오분류돼 있었다(실측). "채권"이 "연체채권"/"매출채권"
    같은 여신·회계 용어에도 부분일치하는 문제, "CPI"가 소재 산업 리포트의
    화학 약어("CPI(무색폴리이미드)")와 충돌하는 문제도 함께 수정. 상세는
    `classifyResearchTopic()` 주석 참고.
  - **한국투자증권 "전략/이슈 리포트"(jkGubun=6) "대체투자 Note" 제외(오너
    지시, 2026-09 — "대체투자는 제외하자")**: 사모대출/BDC 등 이 프로젝트의
    산업분석/투자전략 범위 밖 콘텐츠라 `collect-kis-strategy-research.mjs`
    에서 수집 자체를 건너뛴다(NH FICC 게시판의 대체투자/부동산 제외와 같은
    취지).
  - **업종 필터 추가 → 표준 섹터 분류로 재작업(오너 지시, 2026-09-19 —
    "너무 섹터가 다양해서 섹터별로 선택 조회가 가능하거나" → "산업분석
    분류값을 너무 엉터리도 해두었네.. 섹터 분류값은 한국지수와 미국지수
    분류값을 섞어서 만들어줘")**: 처음엔 원문 `stockName`을 그대로 드롭다운에
    나열했는데(오너 지적대로 "IT"/"IT하드웨어"/"IT산업"/"IT소프트웨어"가
    전부 따로, "산업"/"시장" 같은 수집기 기본값·"DS Defense Daily"/"TGIF"
    같은 게시판 라벨까지 섞여 실측 확인) — `src/lib/research-sector.ts`
    (client/server 공용, server-only 아님 — `classifyResearchTopic()`과
    달리 클라이언트에서 직접 import)로 교체. 표준 목록은 오너가 직접 제시한
    실제 지수 체계 — **KOSPI200 섹터지수 11개 + KOSDAQ150 섹터지수 7개 +
    미국 SPDR Select Sector ETF(GICS) 11개**(다른 세션이 주간 리포트 "주요
    섹터 이슈" 기능용으로 먼저 실측 확인해둔 `lib/weekly/sectors.ts`와
    동일 소스) — 를 합쳐 근접 동의어(생활소비재/필수소비재,
    경기소비재/자유소비재)만 하나로 합친 13개 표준 섹터
    (`SECTOR_LABELS`). `classifySector()`가 stockName+title 키워드 매칭으로
    분류(`classifyResearchTopic()`과 같은 방식·한계 — 완전하지 않음, 실측
    검증 84%). 매칭 안 되는 원문(수집기 기본값·게시판 라벨·애널리스트명
    오기입 등)은 드롭다운에서만 빠지고 "전체"에는 그대로 남음.
  - **인사이트 탭 분리(오너 지시, 2026-09-19 — "해외ib에서 발취되는 것은
    산업분석에 빼서 산업분석 옆에 인사이트라고 탭 만들도록 거기에
    전체/각사별구분으로 넣자")**: 해외 IB/자산운용사 리서치 5곳(골드만삭스·
    JP모간·모간스탠리·블랙록·PIMCO, 바로 위 "해외 IB/자산운용사 리서치 5곳
    추가" 항목 참고)은 국내 산업분석/투자전략/시황 분류 체계가 애초에 안
    맞는 콘텐츠라(블랙록 stockName "글로벌 위클리 시황"이 문자 그대로
    "시황"에 걸려 14일 만에 삭제될 뻔한 문제가 실제 계기) `/[market]/research`
    산업분석 탭에서 완전히 빼고 `/[market]/insights`(`InsightsBoard`,
    `getInsightResearch()`, `/api/research/insights`)라는 별도 최상위 탭을
    새로 만들었다 — 두 탭은 `source` 로 서로 배타적(`INSIGHT_SOURCES` 상수,
    `getIndustryResearch()`는 이 소스들을 조회·정리(prune) 양쪽에서 제외).
    전체/BlackRock/Goldman Sachs/J.P. Morgan/Morgan Stanley/PIMCO 세그먼트로
    구분, classifyResearchTopic() 후처리 분류·투자전략/시황 단기 보존기간
    없이 다른 산업분석 소스와 동일한 90일을 그대로 적용한다. 부수 효과로
    "노출 한계" 문제(CLAUDE.md 위 항목 — 저빈도 소스가 고빈도 국내 소스들에
    밀려 `/api/research/industry` 의 150건 한도 밖으로 밀려나던 문제)도
    해결됨 — 이제 별도 탭이라 국내 산업분석 150건과 경쟁하지 않음.
  - **"해외리서치" 세그먼트 — 인사이트에서 산업분석으로 부분 역이동(오너
    지시, 2026-09-19 — "goldman-sachs-research는 산업분석으로 이동하는데
    시황 오른쪽에 해외리서치라고 분류추가해서 해당리서치는 여기로 분류하고
    여기만 백필기간을 180일로")**: 위 "인사이트 탭 분리"가 5곳 전부를
    산업분석에서 뺀 지 얼마 안 돼, 오너가 골드만삭스의 **리서치 노트만**
    (`goldman-sachs-research` 경로, GS Sustain 등 — 일반 인사이트 아티클과
    다르게 국내 산업분석과 같은 성격의 콘텐츠) 다시 산업분석 탭으로 옮기고
    싶어함 — "모든 걸 산업분석으로"가 아니라 **경로 단위로 정밀하게
    구분**(오너 — "모든것을 산업분석으로 이동이 아니다"). 골드만삭스
    인사이트 하위 실측 7개 경로 중 오너 최종 결정: articles·top-of-mind·
    the-markets·goldman-sachs-exchanges(팟캐스트 2종 포함) → 인사이트 그대로,
    videos·talks-at-gs(영상 2종) → 완전 제외, goldman-sachs-research →
    산업분석 "해외리서치" 세그먼트. 이후 블랙록도 같은 방식으로 확장(오너 —
    "블랙락은 global-investment-outlook은 산업분석으로 정리하고 나머지는
    인사이트에") — `global-weekly-commentary`(매주)는 인사이트, `global-
    investment-outlook`(반기)만 해외리서치.
    - **구현**: 같은 회사라도 콘텐츠 종류에 따라 다른 `source` 문자열을 쓴다
      — "Goldman Sachs"/"BlackRock"(인사이트, `INSIGHT_SOURCES`)과
      "Goldman Sachs Research"/"BlackRock Research"(해외리서치,
      `FOREIGN_RESEARCH_SOURCES`, `shinhan-research.ts`)를 분리. 라우트가
      POST 1회당 source 하나만 받으므로 각 수집기가 콘텐츠 종류별로 나눠
      두 번 전송한다(한경 컨센서스 수집기의 "실제 출처별로 나눠 전송"과
      같은 패턴). `classifyResearchTopic()`이 `FOREIGN_RESEARCH_SOURCES`면
      무조건 "해외리서치"로 분류(다른 국내 키워드 분류 우회, 새
      `ResearchTopic` 값 — TOPICS 배열에 "시황" 바로 오른쪽에 배치).
      `getIndustryResearch()`의 산업 조회·정리 양쪽에서 `INSIGHT_SOURCES`만
      제외하므로 `FOREIGN_RESEARCH_SOURCES`는 자동으로 포함(추가 코드 불요).
    - **180일 보존(오너 지시 — "여기만")**: 다른 산업분석(90일)과 달리
      `FOREIGN_RESEARCH_MAX_AGE_MS`(180일)를 따로 둬 `upsertShinhanResearch()`
      의 전역 정리 단계에서 `FOREIGN_RESEARCH_SOURCES`를 제외하고 별도
      180일 컷오프로 정리. 14~90일 사이 "산업" 카테고리를 재분류해 조기
      삭제하는 후보 조회(`staleIndustryCandidates`)에서도 함께 제외 —
      안 그러면 "해외리서치"가 (시황도 투자전략도 아니니) 기본 30일
      컷오프로 오분류돼 조기 삭제될 뻔했다(구현 중 직접 발견·수정).
    - **블랙록 발행일 근사**: `global-investment-outlook`은 발행일 메타
      자체가 없어(실측) 제목+요약의 연도와 "Midyear" 표기로 반기를
      추정(Midyear면 7/1, 아니면 1/1) — 정확한 발행일이 아니라 근사값.
    - **JP모간은 해외리서치로 옮겼다가 인사이트로 원복(오너 지시,
      2026-09-19)**: "jpm도 글로벌리서치는 산업분석으로 정리하고 나머지는
      인사이트다"란 지시를 받아 `/insights/global-research/` 전량을
      `source: "J.P. Morgan Research"`로 바꿔 해외리서치로 옮겼었는데
      (골드만삭스와 같은 방식), 오너가 실제 화면을 보고 "jpm은 해외리서치로
      싹다옮겼네 내가 원한건 그게 아닌데.. 인사이트로 다시 옮겨라"고
      정정 — 다시 `source: "J.P. Morgan"`으로 되돌려 인사이트 탭으로
      복귀시켰다. **JP모간은 해외리서치 대상이 아니다** — 골드만삭스·
      블랙록만 해당(`FOREIGN_RESEARCH_SOURCES`에 JPM 없음). 소스 전환 시
      옛 문서 정리는 `/api/cron/shinhan-research` DELETE(`source`만으로
      호출, idPrefix 생략 가능하도록 이때 확장)로 처리.
    - **모간스탠리 ESG/개인재무 주제 제외(오너 지시, 2026-09-19 — "esg는
      다 제외" + "Personal Finance 대상에서 제외")**: `<meta
      name="content_topics">`에 기사별 주제 태그가 명시돼 있어(실측) 제목
      키워드 추측 없이 정확히 거른다. ESG/지속가능성 계열 9종(diversity-
      and-inclusion·sustainability·sustainable-investing·sustainable-
      supply-chain·sustainable-finance·corporate-sustainability·
      environmental-social-and-governance-esg·inclusive-growth·
      esg-investing)과 personal-finance 태그가 있으면 그 기사를 통째로
      건너뛴다(인사이트에도 안 실림). "Morgan Stanley Institute"(오너
      확인 — "인사이트에")는 이 필터에 안 걸리는 한 기존처럼 인사이트로
      감, 별도 처리 불필요. 팟캐스트(`/insights/podcasts/`, 379건)는
      "요약본 제공 없이 링크"라 처음부터 수집 대상 밖(오너 확인).
  - **해외 IB/자산운용사 리서치 2차 6곳 조사 — 3곳 구축(오너 지시,
    2026-09-19)**: ING THINK·BNP Paribas·Deutsche Bank·UBS CIO·Citi GPS·
    BofA Institute를 오너가 추가 제시, 실측 결과 **BNP Paribas·
    Citigroup·Bank of America Institute 3곳만 구축**. 전부 `INSIGHT_
    SOURCES`에 추가해 인사이트 탭으로(해외리서치 세그먼트 이관은 이번엔
    없음 — GS/블랙록/JPM처럼 "리서치노트 전용 경로"가 뚜렷이 구분되는
    콘텐츠가 없었음).
    - **BNP Paribas**(`economic-research.bnpparibas.com`): 사이트맵엔
      개별 리포트가 아니라 게시판 허브 URL만 있고 lastmod도 전부
      2022-12-05로 고정(실측 — 최신순 추림 불가) — 대신 게시판 자체가
      `/Publications/{board}/en-US/Page-N` 형식으로 페이지네이션되는
      평범한 서버렌더 HTML이라 그걸 쓴다(Eco-Week·Eco-Flash·
      Eco-Conjoncture·Eco-Emerging·Special-Edition 5개 게시판, 팟캐스트·
      참고자료 게시판은 제외). 발행일 메타가 없어 **제목에 박힌 날짜**를
      파싱("Eco Week September 14, 2026"/"Eco Week 1 June 2026" 등
      형식이 섞여 있음, 실측) — 일자 없이 월만 있으면(드묾) 1일로 근사.
      `scripts/collect-bnpparibas-research.mjs`.
    - **Citigroup**(`citigroup.com/global/insights`): 사이트맵에 1,800개
      URL이 lastmod과 함께 있어(실측) 최신순 추림. Citi GPS류 정통
      리서치 외 지점 개소식 등 PR성 콘텐츠도 섞여 있어(실측 —
      "...-grand-opening-event" 등) 제목 키워드로 일부만 걸러냄(완전하지
      않음). `og:title`/`og:description` 품질 좋음. `scripts/
      collect-citigroup-research.mjs`.
    - **Bank of America Institute**(`institute.bankofamerica.com`):
      사이트맵 169개 URL, lastmod 신뢰 가능(실측). BofA 자체 거래
      데이터 기반 소비자·중소기업 분석(BofA Global Research와는 별개
      조직, 오너 제시 설명 그대로). `sustainability/` 경로는 이 프로젝트의
      기존 ESG 제외 원칙과 동일하게 건너뜀. `scripts/collect-boa-
      research.mjs`.
    - **보류 3곳(실측으로 확인된 막힘)**: **UBS**(`www.ubs.com`)는
      robots.txt 요청 자체가 403(Akamai 차단) — 접근 자체가 막혀있어
      제외. **Deutsche Bank**(`corporatebank.db.com/.../Research`)는
      오너가 제시한 URL이 다른 도메인(`conferences.db.com`)으로 리다이렉트
      되며 404 — 실제 리서치 페이지 경로를 다시 찾아야 함. **ING THINK**
      (`think.ing.com`)는 Algolia 검색(앱ID·키는 페이지에 노출되나
      인덱스명 못 찾음, 골드만삭스와 같은 패턴)으로 그려지고 사이트맵
      URL(`/sitemap/index.html`) 요청은 TLS 재협상 단계에서 타임아웃 —
      브라우저 네트워크 로그 역추적이 더 필요.
  - **3차 3곳 조사 — HSBC 재조사로 구축, Deutsche Bank도 URL 재확인으로
    구축, Barclays·Nomura는 보류(오너 지시, 2026-09-19)**: HSBC Global
    Research·Barclays Research·Nomura Connects 추가 제시. 1차 조사에선
    HSBC가 `gbm.hsbc.com`(HSBC Global Banking & Markets) 기준 공개 콘텐츠
    79건뿐·최신 항목도 2025-10로 정체돼 보류했는데, **오너가 실제 살아있는
    URL(`business.hsbc.com` — HSBC Commercial Banking, 별개 사이트)을
    제시**해 재조사 후 구축 — 사이트맵 362건, 최신 항목이 당일까지 잡힘
    (사이트맵이 UTF-16LE BOM 인코딩이라 `res.text()` 대신 `arrayBuffer()`로
    받아 직접 디코딩 필요, 이 프로젝트에서 처음 나온 케이스). 마찬가지로
    Deutsche Bank도 1차 조사 때 오너가 준 URL(`corporatebank.db.com/...`)
    이 다른 도메인으로 리다이렉트되며 404였는데, **오너가 실제 작동하는
    URL(`dbresearch.com/PROD/IE-PROD/HOME.alias`)을 다시 제시**해 재조사
    후 구축 — 레거시 CMS(Reweb)지만 카드마다 `class="...-date"`/`"...-
    title"`/`"...-teaser"` 세 블록이 순서대로 붙어있는 안정적인 서버렌더
    구조라 정규식으로 바로 파싱(다른 소스들의 "제목에 박힌 날짜 추측"보다
    안정적 — 날짜가 별도 텍스트로 깔끔하게 있음). 홈+Macro+Geopolitics+
    Germany+Corporate Landscape 5개 허브를 함께 훑음.
    **Barclays**(`www.ib.barclays`)는 오너가 준 개별 글 URL은 정상
    작동하지만(og:title/description 있음) sitemap.xml이 실제로는 404이고
    허브 페이지 리스트는 정적 HTML에 전혀 없이 **클라이언트 JS가 로드 후
    주입**함을 이번엔 크롬 확장으로 직접 확인(네트워크 로그의 이미지 요청
    URL에 실제 글 경로가 박혀있어 URL 패턴 자체는 알아냈지만 — `/content/
    barclaysmicrosites/ibpublic/en/{경로}/_jcr_content/image...` → 공개
    URL로 역산 가능 확인 — 이 목록을 매번 새로 알아내려면 진짜 API 호출이
    안 잡히고 브라우저 렌더링이 필요해 무인 수집 스크립트로는 아직 안 됨).
    **Nomura Connects**(`nomuraconnects.com`)는 robots.txt·sitemap.xml
    둘 다 없고 Vite 기반 완전 SPA(실측 — 정적 fetch로는 페이지 골격만
    나옴)라 내부 API 역추적이 필요, 이번엔 착수 안 함.
- **종목뉴스 / 주요 코멘트 탭 (`src/lib/news/`)**: Google 뉴스 RSS(`news.google.com/rss/...`,
  공개 신디케이션 피드 — 기사 본문 스크래핑 아님, 제목·출처·발행시각·원문 링크만)를
  구독하고, 영·일문 제목은 무인증 Google 번역 웹 엔드포인트(실패 시 MyMemory)로
  한국어 번역한다. LLM 요약 없음(비용·본문 소스 미확보로 보류). `post0318/4`
  프로젝트의 `src/lib/server/{brazilNews,translate}.ts` 와 동일 패턴을 이식.
- **빅테크 공식 블로그("기업 발표", `src/lib/news/companyBlog.ts`, 2026-09
  추가, 오너 지시 — "엔비디아처럼 블로그등을 통해 공개하는... 파급력이
  큰데")**: 로이터·블룸버그 등 3자 매체가 받아쓰기 전까진 기존 종목뉴스
  화이트리스트·뉴스 검색에 전혀 안 잡히는 기업 자체 발표를 보강. 공개
  RSS/Atom 피드 구독(Google 뉴스 RSS와 같은 성격, 크롤링 아님) — 실측
  확인된 4곳: NVIDIA(`blogs.nvidia.com/feed/`, RSS)·Apple
  (`apple.com/newsroom/rss-feed.rss`, **Atom** — `<entry>`/`<link href>`
  형식이 RSS 와 달라 별도 파싱)·Google(`blog.google/rss/`)·Meta
  (`about.fb.com/news/feed/`). Microsoft 는 기본 UA 에 403(봇 차단)이라
  제외 — 나중에 다른 방법을 찾으면 추가. 블로그에 소비자 콘텐츠(NVIDIA
  GeForce NOW 게임, Apple Arcade/Apple TV 엔터테인먼트 등, 실측 확인)가
  섞여 있어 기업별 `relevance` 정규식으로 AI·반도체·재무·제품 발표만
  거른다. 두 군데서 쓴다: ① 주간 리포트(`weekly/issues.ts`
  `COMPANY_BLOGS_BY_TOPIC` — 지금은 NVIDIA→"AI·반도체 수요" 이슈만) ②
  종목 페이지 "리서치" 탭의 "기업 발표" 카드(`/api/markets/us/[symbol]/
  company-blog`, DB 없이 매번 짧은 캐시로 직접 조회 — 새 탭 대신 기존
  탭에 통합, 종목이 4개뿐이라 별도 최상위 탭은 과하다고 판단).
- **인플루언서 텔레그램 채널 수집 트리거(2026-09)**: 수집 자체는
  다른 소스와 같은 구조(로컬/Actions 수집 → DB 적재 → 배포본은 조회만)이지만
  **트리거만 두 겹**이다. GitHub `schedule` 이 이 저장소에서 실행률
  21%(20시간 기대 29회 중 6회, 실측)에 그쳐 화면이 몇 시간씩 멈춰 보였고,
  분 값을 정각에서 비껴도 개선되지 않았다(지연이 아니라 예약 자체가 누락).
  그래서 ① 워크플로가 한 번 뜨면 그 안에서 5시간 30분 동안 15분 간격으로
  반복 수집하고, ② 외부 크론(cron-job.org)이 2시간마다 `workflow_dispatch`
  로 그 루프를 다시 띄운다. ②가 없으면 구멍이 난다 — 실측(30시간)에서
  `schedule` 간격에 7시간 5분·5시간 34분 공백이 있었고 둘 다 루프 수명을
  넘는다. **크론 간격을 짧게 두면 안 된다**: `cancel-in-progress: true` 라
  새 실행이 돌던 루프를 끊어서, 15분 간격이면 준비 작업만 반복하고 실행
  이력이 취소로 찬다. 이 채널만 분 단위 신선도가 의미 있어 예외로 두고,
  하루 1회인 리서치 수집기들은 그대로 `schedule` 을 쓴다. 설정 절차와
  401 대처는 `DEPLOY.md` §6 참고. 회당 채널당 50건을
  가져오고 `_id` 로 upsert 하므로 실행이 밀려도 중간 글이 유실되지 않는다
  (이전 10건 제한 때 63708~63713 유실 실측).
- `yahoo-finance2` / yfinance / Finnhub·FMP·Polygon 무료 = **개인용 한정.**
  팀/대외 확장 시 인앱 중단 → 딥링크 또는 정식 라이선스 (prd.md §4.3).
- L1(공식 API)·L3(자체 계산)은 모든 시나리오에서 안전.

## 주간 거시·시황 리포트 (`/weekly`, 오너 지시 2026-09)

"한 사람 인력 대체" 목적 — 매주 월요일 지난 한 주의 한국·미국 시장, 브라질
국채, 금·원유 원자재, FOMC·BOJ·BOK 금리정책, AI 기술 이슈를 **A4 1장**으로
요약한다. 기업분석은 범위 밖(거시이므로 제외). 코드는 `src/lib/weekly/`,
DB는 `weekly_reports`(주당 1건, `_id`=대상 주 월요일) + `weekly_llm_usage`.

- **흐름**: GitHub Actions(`.github/workflows/weekly-report.yml`, 월 09:00
  KST) → `POST /api/cron/weekly-report`(CRON_SECRET) → `generateWeeklyReport()`
  → 초안(draft) 저장 → 오너가 `/weekly` 화면에서 편집·발행. 화면의 "초안
  생성/재생성"은 로그인 세션으로 `POST /api/weekly`(proxy.ts 보호).
- **입력 코퍼스**(`corpus.ts`, 원문 미저장): `kr_research` `category:"산업"`
  중 거시·전략·시황·AI/반도체 키워드 발췌(주간 200~400건), Google 뉴스 RSS
  제목(고정 검색어 16개), 텔레그램 게시물, 인플루언서 유튜브 영상 제목.
  **본문 스크래핑은 이 작업에 한해 오너 승인**(2026-09, 원문 미저장 조건)
  — 아직 미구현(뉴스 본문·PDF·유튜브 자막은 2단계).
- **시세 스냅샷**(`snapshot.ts`): 전 지표를 "지난주 금요일 vs 전전주 금요일"
  같은 구간으로 맞춤(데모 때 자산별 구간이 제각각이라 표가 뒤섞였던 문제).
  Yahoo(지수·미국채·원자재·환율), ECOS(국고채), 브라질 중앙은행 SGS(Selic —
  시리즈에 다음 COPOM 까지 미래 일자가 미리 들어있어 실행일 이전 값만 사용).
  **브라질 장기 국채(NTN-F ~10년)는 오너의 4번 프로젝트**(github.com/post0318/4,
  재무부 CSV를 매주 갱신·커밋)의 JSON 을 GitHub raw 로 읽는다(오너 안내 —
  Tesouro Direto 공개 JSON 은 410 Gone). 4번 저장소의 갱신 크론을 월 09:00
  UTC → **일 12:00 UTC 로 앞당겨**(오너 지시, 2026-09-15) 월요일 아침 우리
  크론 시점에 지난주 금요일 값이 있도록 함. 그래도 갱신이 밀리면 asOf 를
  표기하고 그 시점 기준 7일 전과 비교. Yahoo
  환율·일부 지수는 봉 타임스탬프가 전일 23:00Z 라 20시 이후 봉을 다음 날로 보정.
> **LLM 제거 (오너 지시, 2026-09) — "주간 리포트는 LLM 사용 없이 가자.
> LLM 을 통해 추론을 안 하는 것일 뿐 시장 요약 정리는 유효하다."**
> 아래 Gemini 문단은 과거 기록이다. 현재는 본문을 **코드로 조립**한다
> (`render.ts`) — 문장을 지어내지 않고 집계 숫자와 실제 기사·리포트 제목·
> 링크만 배치하고, 해석은 오너가 편집기에서 코멘트 줄에 직접 쓴다.
> - **핵심 이슈 3개**(`issues.ts` + `topics.ts`): 주제 사전 16개에 대해
>   ①증권사 산업·전략 리포트 빈도(주 신호) ②그 주 뉴스 건수 ③네이버
>   데이터랩 검색어 트렌드를 각각 0~1 로 정규화해 가중 합산(0.5/0.3/0.2)
>   하고 상위 3개를 뽑는다. 채택 안 된 후보도 건수·점수와 함께 `candidates`
>   에 남겨 화면 접힘 영역에서 검수할 수 있다.
>   - 왜 사전인가: 형태소 분석기 없이 한국어 제목에서 주제어를 뽑으면 결과가
>     들쭉날쭉하다. 다룰 범위가 정해져 있어(`prd.md` 주간 리포트 범위) 주제를
>     미리 적어 두고 빈도만 세는 쪽이 재현 가능하고 근거를 그대로 붙일 수 있다.
>     이 프로젝트가 이미 쓰는 `classifyResearchTopic()` 과 같은 방식.
>   - 오탐 주의: 정규식이 한국어 복합명사에 부분일치한다. 실측으로 잡아
>     제외한 것 — "유가증권시장"(코스피 정식 명칭)이 유가 이슈로, "골드만삭스"
>     가 금 이슈로, 멀티플 표기 `EV/EBITDA` 가 전기차로 새던 문제.
>   - 집계 기간 상한 필수: `date >= weekStart` 만 걸면 주중 수동 실행 때
>     이번 주 리포트가 딸려 들어와 "지난주" 집계가 아니게 된다(실측). 금요일
>     +3일(다음 월요일)까지만 — 월요일 오전 발간분은 지난주 정리 성격이라 포함.
>   - **네이버 검색어 트렌드**(`datalab.ts`) — 켜져 있다(2026-09 확인).
>     **경로 주의**(오너 확인 — "네이버는 API HUB 이고 바라봐야 하는 곳이
>     달라졌다"): 뉴스 검색과 **같은 허브 호스트**에 경로만 다르다 —
>     `naverapihub.apigw.ntruss.com/search-trend/v1/search`. 인증 헤더도 같은
>     `X-NCP-APIGW-API-KEY-ID`/`X-NCP-APIGW-API-KEY`. 실측으로 확인한 막다른
>     길 셋: 개발자센터(`openapi.naver.com/v1/datalab/search`)는 API 허브로
>     이관돼 401, 옛 게이트웨이(`naveropenapi.apigw.ntruss.com/datalab/v1/
>     search`)도 이 키로 401, 허브의 `/datalab/v1/search` 는 404.
>     **키가 뉴스 검색과 다르다**: 허브 애플리케이션이 `news`(검색)와
>     `trend`(검색어 트렌드)로 나뉘어 있고 트렌드는 `trend` 앱에만 켜져 있다.
>     `news` 키로 부르면 "요청한 API는 이 Application 에서 활성화되어 있지
>     않습니다" 가 온다. 그래서 `NAVER_TREND_KEY_ID`/`NAVER_TREND_KEY_SECRET`
>     를 따로 읽고 없으면 검색용 키로 폴백한다. 키가 없거나 실패하면 조용히
>     건너뛰고 검색 가중치는 리포트·뉴스로 비례 배분한다(0 으로 두면 총점만
>     낮아지고 순위는 그대로라 무의미).
>     - **요청마다 100 이 다시 매겨진다 — 기준 그룹 필수**: 데이터랩은 한
>       요청 안에서 1등을 100 으로 놓는다. 주제를 나눠 보내면 묶음마다 1등이
>       100 이 돼 서로 비교가 안 된다(실측 — 뉴스 3건짜리 "중국 경기"가 100,
>       뉴스 100건짜리 "원달러 환율"도 100). 모든 요청에 같은 기준 키워드
>       ("주식") 한 그룹을 끼워 넣고 그 값으로 나눠 같은 자로 잰다. 그룹은
>       요청당 5개까지라 주제는 4개씩 보낸다. 고친 뒤 중국 경기 0, 원달러
>       환율 100 으로 정상화.
>   - **구글 트렌드는 못 쓴다(실측, 2026-09)**: 오너가 먼저 제안했으나 확인
>     결과 쓸 수 있는 건 `trends.google.com/trending/rss` 하나뿐이고, 한 번에
>     10개·약 40분 구간만 주며 내용이 연예·스포츠 위주라 시장 이슈가 거의 안
>     걸린다(실측 목록: 골 때리는 그녀들, 변호사, 이정후 …). `category=`
>     파라미터는 무시되고, 옛 `realtimetrends`·`dailytrends` API 는 404.
> - **금리정책·다음 주 일정**: 미리 정한 검색어(`POLICY_QUERIES`,
>   `CALENDAR_QUERIES`)의 그 주 기사를 제목·매체·링크 그대로 건다
>   (오너 지시 — "정책, 일정은 정해진 기사를 보여주는 것").
> - **한 줄 결론**: 스냅샷에서 주간 변동이 가장 큰/작은 자산을 짚는 한 줄.
>   해석이 아니라 크기 비교라 코드로 낸다.
> - DB 스키마는 그대로 두고 `model: "rule-based"`, 토큰·비용 0 으로 저장한다
>   (기존 문서와 호환). `weekly_llm_usage` 예산 검사는 더 이상 걸지 않는다.
> - `lib/weekly/gemini.ts` 는 **남긴다** — 발표자료(PPT) 생성이 아직 쓴다
>   (`lib/ppt/gemini-profile.ts`). 주간 리포트만 LLM 을 뗐다.

**LLM 재도입 — 코멘트만(오너 지시, 2026-09-18 — "미안하다 llm을 부활한다.
하지만 llm 퀄리티는 낮다고 느껴지기에 더 잘해야한다")**: 위 "LLM 제거"는
본문 전체를 LLM이 쓰던 옛 접근(`prompt.ts` + `corpus.ts`, 지금도 미사용
으로 남아있음)에 대한 기록이고, 표·구조·숫자는 지금도 전부 코드가 만든다
(안 바뀜). 새로 추가된 것은 그 위에 얹는 **해석 코멘트 한 줄뿐**
(`comment.ts`) — 스냅샷 표 코멘트 칸·이슈별 "코멘트" 줄만 채운다. 입력은
`issues.ts`가 이미 고른 이슈 근거(증권사 리포트·뉴스 제목 상위 3건씩)와
스냅샷 수치뿐이라 `corpus.ts`(텔레그램·유튜브까지 포함한 더 넓은 코퍼스,
여전히 미사용)보다 훨씬 좁다. **검증 단계 추가** — 바로 위 "Gemini 결과
검증 교훈"이 지적한 수치 왜곡(표 수치가 뒤섞이던 문제)을 막기 위해, 응답
문장에 %/bp/배/pt/건 단위 수치가 나오면 원본 수집 데이터와 대조하고
근거 없는 수치가 하나라도 섞이면 그 코멘트 전체를 버린다(빈 문자열로
폴백 — 절반만 맞는 문장을 노출하지 않음). `generate.ts`가 월 예산
(`WEEKLY_MONTHLY_BUDGET_USD`) 확인 후 호출하고, 미설정·예산초과·API
실패는 조용히 rule-based(빈 코멘트)로 폴백.

**웹검색 그라운딩 켬(오너 지시 2026-09-18)**: 처음엔 꺼뒀으나(코멘트는
수집한 데이터 안에서만 해석) 오너가 실제 초안을 보고 "스냅샷은 이슈와
무관하게 각 자산의 특이점(상승 원인·하락 사유)을 말해야 한다"고 지적 —
스냅샷 16개 자산 각각의 "왜"를 설명하려면 미리 모아둔 이슈 3개 근거만
으론 부족해(나머지 13개는 근거가 아예 없음) 실시간 검색이 필요했다.
그라운딩 과금은 **월 5,000건 무료, 초과분 $14/1,000건**(2026-09-21 공식
단가 확인). 과금 단위는 API 요청이 아니라 **모델이 실제로 날린 검색 쿼리
하나하나**다. 이 앱에서 그라운딩을 쓰는 곳은 주간 리포트 코멘트(주 1회 ×
2~3콜)와 발표자료 기업 프로필(`lib/ppt/gemini-profile.ts`, PPT 내보내기당
1콜) 둘뿐이라 월 수백 건 — 무료 한도의 한 자릿수 %라 실제 청구액은 $0 다.
그래서 코드는 **0 으로 둔다**(오너 판단 2026-09-21). 종전 $0.035 는 근거
없는 추정치로, 회당 $0.07~0.10 을 없는 비용으로 잡아 월 예산을 헛되이
갉아먹고 있었다. 그라운딩 쓰는 기능이 늘어 월 5,000 쿼리에 근접하면
건당 $0.014 로 되살린다. 검증 단계도 그라운딩 성공 여부로 갈린다 — 그라운딩이
실제로 출처를 찾아왔으면(`groundingSources` 있음) 그 결과를 신뢰하고
수치 대조를 건너뛴다(우리가 안 가진 외부 사실을 인용하는 게 정상이므로).
출처 없이 끝났으면(검색 실패 등) 기존처럼 %/bp/배/pt/건 수치를 원본
데이터와 엄격 대조하는 안전망이 그대로 작동한다.

**한 줄 결론도 인과관계로(오너 지시 2026-09-18)**: 처음엔 스냅샷에서
최대/최소 변동 자산만 기계적으로 뽑는 `movers()`(순수 비교, 해석 없음)
였는데 "딸랑 상승·하락 2개만 적고 끝이냐, 인과가 있어야" 지적을 받아
Gemini가 `headline` 필드로 "이번 주 시장 전체가 무엇 때문에 이렇게
흘렀는지"를 종합 서술하도록 바꿨다(topMovers 하나만이 아니라 스냅샷
전체를 훑어 공통 배경을 찾게 함). 검증 실패/미설정 시 `movers()` 사실
나열로 폴백 — 섹션이 빈 채로 남지 않는다.

- **LLM = Gemini API**(`gemini.ts`, REST, SDK 없음). 모델 비교(Sonnet 5/
  Opus 5/Fable 5.1 샘플) 후 오너가 비용 문제로 Claude API 대신 선택 —
  **Google AI Pro 구독에 포함된 월 $10 Cloud 크레딧**으로 결제(유료 등급이라
  프롬프트가 학습에 안 쓰임). 기본 모델 **`gemini-3.8-flash`**
  (`GEMINI_MODEL`로 교체, 404면 폴백 체인), 웹검색 그라운딩 기본 ON
  (`WEEKLY_GROUNDING=0`으로 끔). 월 상한 `WEEKLY_MONTHLY_BUDGET_USD`(기본 8).
  회당 추정 0.25~0.4달러. 키는 `GEMINI_API_KEY`(.env.local + Vercel).
- **모델 선택 근거(오너 결정 2026-09-21)** — 원래 `gemini-3.1-pro-preview`
  였다. 같은 주(2026-09-14~18) 같은 입력으로 실측 비교한 결과 3.8 Flash 로
  교체: 소요 73.7s→20.0s, 비용 $0.381→$0.270, 품질은 오히려 더 구체적이었다
  (사우디 환적 건에 "대체 수송로 확보"를 덧붙이고, 한국은행 항목에 금리차·
  환율·유가 세 요인을 짚는 식). 티어상 Pro 가 상위지만 세대 차(3.1 → 3.8)가
  뒤집은 것으로 본다. Pro 는 preview 라 안정성도 불리했다(Flash 계열은 stable).
  다시 비교하려면 `gh workflow run weekly-model-compare.yml -f models="a,b"` —
  같은 주 입력으로 모델별 결과를 나란히 내고 DB 엔 저장하지 않는다
  (`compareWeeklyModels`, `/api/cron/weekly-model-compare`).
- **단가는 프로모션이다** — 3.x Flash 는 2026-12-31 까지 입력 $0.75 / 출력
  $3.75(1M 토큰당)이고 **2027-01-01 부터 $1.50 / $7.50 으로 두 배**가 된다.
  `gemini.ts` 의 `PRICE` 를 그때 갱신해야 예산 검사가 어긋나지 않는다.
- **출력 형식**(`prompt.ts`): 한 줄 결론 / 스냅샷 표 / 핵심 이슈 3개(트리거→
  파급 경로→확인된 시장 영향→주시 포인트, 출처) / 금리정책 / 다음 주 일정.
  표 제외 본문 1,300자 목표, 1,800자 초과 시 압축 호출 1회. 리포트 뒤에
  `<<<후보이슈>>>` 구분자로 검수용 후보 이슈 8~12개를 붙이게 해 `candidates`
  필드에 분리 저장(발행본엔 미포함, 화면 접힘 영역에 표시).
- **Gemini 결과 검증 교훈(2026-09)**: 오너가 Gemini 앱으로 만든 샘플을
  실측한 결과 새 사실(송유관 피격 등)은 실제였지만 표의 수치가 목/금 종가가
  뒤섞이고 10년물이 본문·표에서 세 값으로 달랐다 — 그래서 수치는 모델에
  맡기지 않고 스냅샷 모듈이 계산해 넣고, 프롬프트에 "제공 수치만 사용"을
  강제한다.

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

### 미국 EV·EBITDA·차입금 단일 기준 (오너 결정 2026-09-23)

같은 종목의 EV/EBITDA·PBR·순차입금이 화면마다 달랐던 문제(WMT 등)를 없애려고
계산을 한 곳에 모았다. **화면별로 따로 계산하지 말 것** — 주식수는
`lib/markets/us/edgar-shares.ts`, EV·차입금·현금·감가상각비는
`lib/markets/us/edgar-ev.ts` 만 쓴다(하이라이트·재무분석·대차대조표·손익·현금흐름·
개요 멀티플·컨센서스 전부). 42종목·200종목 실측과 사이트 대조 후 정한 규칙:

- **EV** = 시가총액 + 이자부 차입금(금융리스 포함) + 우선주 + 비지배지분 − 현금.
- **운용리스는 차입금에서 제외** — EV·순차입금·신용지표 모두. 미국 회계기준
  (ASC 842)은 운용리스 부채를 영업부채로 분류하고, EBITDA 에 임차료가 이미 빠져
  있어 넣으면 이중 반영. MarketScreener 와 같은 기준(Yahoo·StockAnalysis·Finviz 는
  포함). 규모는 대차대조표 주석 "운용리스 부채", 부채비율만 "총차입금(운용리스
  포함) / 자기자본" 별도 행(S&P·Moody's 식 참고치).
- **현금** = 현금 + 단기투자 + 장기 투자증권(채권형). **장기투자자산
  (LongTermInvestments)은 빼지 않는다** — UNH·GE 는 보험 투자자산, MSFT 등은
  지분법 투자라 영업용(조사한 사이트 모두 동일).
- **EBITDA** = SEC 보고 영업이익 + 감가상각비(조정 EBITDA 아님 — 사이트마다 조정
  방식이 달라 재현 불가). 감가상각비는 합계 태그가 여럿이면 **최댓값**, 무형상각이
  빠졌으면 구성항목 합(`pickDa`).
- **UP-REIT 운영 파트너십 지분**: Yahoo impliedShares − sharesOutstanding 를 시가로
  EV 에 더하고 그 장부가는 비지배지분에서 뺀다(리츠 SIC 6798 만).
- **EV 미표시**: 은행(`isFinancialCompany`), 금융 자회사 보유 기업(F·GM·CAT·DE 등 —
  **최종 방식 보류, 임시 미표시**: 차입금만 제조 부문으로 빼면 리스 차량 감가상각이
  섞인 연결 EBITDA 때문에 GM 1.8배처럼 무의미해짐), 차입금 태그 미공시 기업.
- **모기지 리츠(NLY·AGNC 등)는 종목분석 대상에서 제외** — 선택 시 "해당 종목은
  지원되지 않습니다" 팝업(`/api/markets/[market]/[symbol]/support`,
  `isMortgageReit`). 전용 지표는 만들지 않는다(오너 결정).
- 태그 함정(실측): 회사가 표준 태그를 중단(GE 현금 2017·영업이익, SBUX 현금 2022)
  → 최근 12개월 계산은 마지막 연간값이 550일 넘은 태그를 버린다(`isStaleAnnual`).
  주식수 단위 오류(MCD 가중평균 `716.4` = 7억 1,640만 주) → `fixScale`.
- **영업이익 단일 기준 시계열**(`edgar-ev.ts` `opIncomeEntries`, 로더가 합성 개념
  `OperatingIncomeLossUnified` 로 끼워 넣음): 공시 OperatingIncomeLoss → 태그가 없거나
  끊긴 뒤의 기간은 **세전이익 + 이자비용**(EBIT) → 이자비용도 없으면 세전이익.
  영업이익 태그가 없는 S&P 500 67개사 실측(Yahoo 대조): 세전+이자 중앙값 오차 7.4%,
  세전 16.9%, 종전 매출총이익−판관비−연구개발비 23%. 하이라이트·재무분석·손익계산서·
  개요·컨센서스가 모두 이 시계열만 읽는다(예전엔 폴백이 모듈마다 달라 BMY 등 EBITDA 가
  화면마다 갈렸다). 손익계산서는 합성 시 행 이름에 "(태그 없음 · 세전이익+이자비용 근사)".
- **반올림 재태깅 제거**(`edgar-series.ts` `dropRoundedRetags`, 로더에서 1회): 나중
  공시가 과거 기간 값을 본문 문장의 반올림값("$189 billion")으로 다시 태깅하면 "최신
  공시 우선" 규칙이 정밀값을 덮어썼다(AXP 2021 총자산, 샘플 25개사 528건 — 영업이익·
  매출원가 포함). 먼저 공시된 값을 1억·10억·100억 단위로 반올림한 값과 정확히 같으면 버린다.
- **20-F ADR**(`lib/markets/adr.ts`): 20-F 제출사의 EDGAR 주식수는 본국 보통주 기준 —
  Yahoo 주식수와 1.5배 넘게 다르면 ADR 비율로 보고 환산(TSM 1 ADR = 5주, 시가총액이
  5배로 나오던 문제). ASML·SPOT 은 1:1 이라 무보정.
- **현재 주식수 = EDGAR 보강 → 인포맥스 보정 → 실패 시 Yahoo**(오너 결정 2026-09-24 —
  "시가총액은 완벽해야", 인포맥스 대비 차이 0 이 목표). 과거 연도 주식수는 EDGAR 그대로.
  - EDGAR 보강(`us/edgar-gapfill.ts`, companyfacts 로더에서 1회): ① SEC companyfacts 가
    최신 10-Q/10-K 를 통째로 빠뜨리는 경우(BE 2분기 — LTM 이 03-31 에 멈춤)와 CIK 변경
    (XOM 2026-07 지주사 재편, 2분기부터 새 CIK)은 공시 목록에 있는데 companyfacts 에 없는
    정기공시의 XBRL 인스턴스를 직접 읽어 채운다. ② 표지 주식수를 클래스 차원에만 다는
    복수 클래스 종목(META·DELL)은 인스턴스의 클래스별 값을 합산(Visa 형은 전환비율
    미반영이라 제외).
  - 인포맥스 보정(`us/current-shares.ts`): 인포맥스 종목분석(`globalmonitor.einfomax.co.kr`
    `/facset/tickerlist/usa` → `/facset/getPriceData` 의 `주식수`, FactSet, 천 주 단위, 로그인
    불필요 — GlobalMonitor 리서치와 같은 도메인, robots.txt 없음). 표지 기준일 뒤 증자
    (INTC 08-12 2.4억 주)·as-converted(V)까지 반영. 주가는 하루 늦어 안 쓴다.
  - Yahoo 는 **EDGAR 표지가 45일 넘게 오래됐을 때만**. 실측: SEC 와 둘이 다른 5건에서
    인포맥스 5건 일치·Yahoo 0건(WMT 는 Yahoo = 직전 분기 표지, MRVL +2.5%).
  - 서버 개요 응답(재무 생략)은 이 주식수가 없어 미국 시가총액을 비운다(Yahoo 값 노출 방지).
- **주식수 힌트**(`us/shares-hint.ts`): 주식수 태그가 없는 기간에 쓰는 Yahoo 기반 값 —
  라우트·컨센서스가 같은 함수를 쓴다(BKR 2021~22 컨센서스만 빈칸이던 문제).
- **사업연도 EPS**는 `fyEps` 하나(공시 희석 EPS → Class A → 보통주 귀속 순이익 ÷
  가중평균 희석주식수 → 근사). 계속영업 EPS 태그는 쓰지 않는다(DELL FY2022 중단영업).

### 한국 EV·차입금 단일 기준 (B16, 2026-09-23)

`lib/markets/kr/dart-ev.ts` 한 곳 — 하이라이트·재무분석·대차대조표 주석·개요 멀티플
(`getTtm` 스냅샷)·컨센서스가 모두 여기서 받는다. 미국과 같은 구조:

- **EV** = 보통주 시가총액 + **우선주 시가총액(우선주 자체 KRX 시세, 오너 결정
  "우선주는 포함한다")** + 총차입금 + 비지배지분 − 현금성자산.
- **총차입금 = 차입금·사채·리스부채**(IFRS 16 은 리스료가 EBITDA 밖이라 리스 포함 —
  미국과 반대). 계정 ID 패턴 + 표준코드 미사용 라인은 계정명. 한전·HD현대 계열처럼
  차입금을 "(유동|비유동|단기|장기)금융부채"(`Other*FinancialLiabilities`)로 공시하면
  **다른 차입금 라인이 없을 때만** 그 금액을 쓴다("기타금융부채"는 미지급비용 등이라 제외).
- **현금성자산** = 현금및현금성자산 + 단기금융상품 + 단기투자자산 + 유동 상각후원가·
  FVPL 금융자산(네이버 WiseReport 정의). **"기타유동금융자산"은 제외** — 네이버가 주석
  내역으로 회사마다 일부만 넣는 것으로 보이며 BS 만으론 못 가른다(실측 33종목·147개
  연도: 제외 시 평균 |차이| 0.19조, 포함 0.23조). 남은 차이(기아·LG엔솔·한전KPS 등)는
  이 항목 차이.
- **시가총액** = KRX 일별 전종목 MKTCAP(그날의 실제 상장주식수 × 종가, `fetchKrxCapsOn`).
  연말 주가도 KRX 실제 종가(DART EPS 가 당시 기준이라 분할 보정가와 섞지 않음). 현재가는
  개요와 같은 `getEodQuote`.
- **PBR 분모 = 지배주주 자본**, **EPS = `krEpsByYear`** — 미국과 같은 원칙, 전 화면 공통.
- **EV 미표시**: 금융업(예수부채·보험계약부채 계정), 금융 자회사 연결(현대차 — 미국과
  같이 최종 방식 보류).
- DART 연간 로더(`dart-facts.ts`)는 **연도별로 가장 최신 보고서의 값만** 받는다 — 옛
  보고서가 같은 계정을 다른 ID 로 태깅해 같은 해가 두 번 합산됐다(SK하이닉스 2021).
- 네이버 순부채 대조(1회성 검증용 데이터, 앱에는 없음): 종전 평균 |차이| 24.5조 → 0.19조.

### 재무 숫자 검증 체계 (오너 지시 2026-09-23 — "검증체계는 구축해라")

- **1층 강제**: `eslint.config.mjs` 의 `no-restricted-syntax` — 미국 멀티플 계산
  모듈(edgar-highlights·edgar-analysis·multiples)에서 차입금·리스·감가상각비·
  장기투자 태그 문자열을 직접 쓰면 린트 오류. 공통 모듈(`edgar-ev.ts`·
  `edgar-shares.ts`·`edgar-pershare.ts`)을 거칠 것.
- **2·3층**: `npm run verify:financials -- --symbols=AAPL,WMT` (또는 `--universe`,
  `--sp500`, 한국은 `--market=kr --universe` — 2층만). 실행 중인 앱 API 를 그대로 불러 사용자가 보는 숫자를 검사한다.
  2층 = 화면 간 동일성(EV/EBITDA·PER·PBR·PSR·EBITDA·순이익·차입금) + 항등식
  (EV 브릿지 합, 공시 EPS × 가중평균 주식수 ≈ 순이익, 자산 = 부채 + 자본), 결과는
  통과·실패·**검증불가**(값이 없으면 통과로 치지 않음). 3층 = Yahoo 분기 재무제표
  합계와 대조한 **검토 목록**(정의 차이가 있어 판정하지 않음). 결과는
  `reports/verify/`(git 제외). 공시 자체의 계산 차이(AT&T 2022 EPS 등)는 검토 목록.
- **주의**: `.env.local` 을 `vercel env pull` 로 받으면 민감 변수(MONGODB_URI·
  KRX_API_KEY 등)가 빈 값으로 온다 — 유니버스 검증·한국 시가총액이 안 된다.
- `edgar-pershare.ts`: 지배주주 순이익(NetIncomeLoss 없으면 ProfitLoss − 비지배지분),
  LTM EPS(보통주 귀속 LTM 순이익 ÷ 현재 주식수 — 주당 지표에 흐름식 금지),
  사업연도 EPS, 자기자본(재작성본 우선), 배수 부호 규칙(분모 0 이하 비움).
- 은행 순수익은 태그가 은행마다 달라 합성한다(`edgar-financial.ts`
  `withFinNetRevenue`: RevenuesNetOfInterestExpense → Revenues → 순이자이익 +
  비이자이익). 대형 은행 14곳 중 12곳이 첫 번째 태그를 안 써서 비어 있었다.

## 숫자 소수점 처리 (오너 지시 2026-09-23 — "조건은 통일되어야")

**서버는 원값을 보내고, 소수점 처리는 화면의 `lib/format.ts`(버림)에서만.** 서버에서
반올림하면 같은 값이 화면마다 0.01 다르게 보인다(컨센서스 EV/EBITDA 7.62 vs
하이라이트 7.61). 화면에서 `toFixed`(반올림)로 숫자를 찍지 말 것 — `formatNumber`·
`formatMultiple` 사용. 주간 리포트(`lib/weekly`)·거시경제(`lib/macro`)는 PDF 문자열·
LLM 수치 검증·지수 관행 때문에 이번 통일에서 제외(별도 결정 대기).

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
