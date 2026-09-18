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
  - **업종 필터 추가(오너 지시, 2026-09-19 — "너무 섹터가 다양해서 섹터별로
    선택 조회가 가능하거나")**: 국내는 수십 개 증권사가 저마다 다른 업종명을
    쓰다 보니 "산업분석" 목록 하나에 업종이 너무 많이 섞여 스크롤이 길어지는
    문제 — 추가 API 호출 없이 이미 받아온 목록의 `stockName` 별 건수를 세어
    드롭다운으로 필터링한다(`IndustryResearchBoard` 의 `sector` state).
    라디오버튼도 검토했으나 업종 수가 많으면 줄바꿈이 심해져 드롭다운으로
    구현. topic 전환 시 업종 선택은 초기화됨.
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
요청당 +$0.035. 검증 단계도 그라운딩 성공 여부로 갈린다 — 그라운딩이
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
  프롬프트가 학습에 안 쓰임). 기본 모델 `gemini-3.1-pro-preview`
  (`GEMINI_MODEL`로 교체, 404면 폴백 체인), 웹검색 그라운딩 기본 ON
  (`WEEKLY_GROUNDING=0`으로 끔). 월 상한 `WEEKLY_MONTHLY_BUDGET_USD`(기본 8).
  회당 추정 0.3~0.6달러. 키는 `GEMINI_API_KEY`(.env.local + Vercel).
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
