# 데이터 수집 일람

이 앱이 외부에서 받아 오는 데이터를 **묶음별**로 정리한 문서다(2026-10-03 작성 — 오라클 이전과 함께).
수집 방식·빈도·저장처를 바꾸면 이 문서부터 고친다. 사이트별 예외 승인의 근거·경위는 CLAUDE.md "데이터 레이어" 절에 있다.

- **실행 위치**: 예약 작업은 전부 **오라클 메인 서버 systemd 타이머**(2026-10-04 이전 완료 — `ops/oracle/install-schedules.sh`, 목록은
  DEPLOY.md §0). GitHub 워크플로는 예약을 지우고 수동 비상용으로만 남겼다(GitHub 예약은 누락·지연이 잦았다 — 실측 21%).
  예외: BNK 는 사무실 PC(해외 IP 차단).
- **새 글만 처리**: 국내 리서치는 08시 회차만 수집기 기본 범위(3~14일)로 넓게 보고 10~18시 회차는 최근 1일(`--days=1`)만 본다
  (`run-research.sh`). 리포트 PDF 텍스트는 서버 디스크 캐시(`/opt/macro/research-cache`, 30일)라 이미 받은 PDF 는 다시 내려받지 않는다
  (실측: 한경 146초 → 12초).
- **전송 주소**: 수집기는 모두 `APP_URL`(저장소 변수, 지금 오라클)로 보낸다 — `scripts/lib/app-url.mjs`.
- **시각은 전부 한국 시간(KST)**.
- **빈도 원칙**: 실행을 정시로 확실하게 만드는 것과 횟수를 늘리는 것은 별개다. 크롤링 예외 승인 소스는 승인된 횟수를 넘기지 않는다.
  공식 API(DART·SEC)는 공시가 날 때만 데이터가 바뀌므로 자주 부를 이유가 없다. 유료·크레딧 API(Gemini·Anthropic·PDFShift)는
  예약이 아니라 필요할 때만 호출된다(주간 리포트 초안만 주 1회 예약).

---

## ① 리서치

쓰는 화면: 산업분석 탭, 인사이트(해외 IB)·비상장 리서치 탭, 종목분석의 "리서치" 카드(종목별 리포트), 주간 리포트 입력.
저장: MongoDB `kr_research`(라우트 `/api/cron/total-research`). 원문 PDF·전체 본문은 저장하지 않는다(요약 발췌·목표주가 등만).

### ①-1 국내 · robots 제한 없음 — 하루 6회 (08·10·12·14·16·18시)

| 소스 | 워크플로 | 스크립트 | 비고 |
|---|---|---|---|
| 한화투자증권 | `hanwha-research` | `collect-hanwha-research.mjs` | robots 가 경로를 막지 않음 |
| 미래에셋증권 | `mirae-research` | `collect-mirae-research.mjs` | robots 에 Disallow 없음 |
| 삼성증권 | `samsung-research` | `collect-samsung-research.mjs` | robots `Allow: /`, PDF 로 목표주가 보강 |
| 키움증권 | `kiwoom-research` | `collect-kiwoom-research.mjs` | robots `Allow: /`, PDF 로그인 불필요 |
| GlobalMonitor(연합인포맥스) | `globalmonitor-research` | `collect-globalmonitor-research.mjs` | robots 없음, 다수 증권사 미국주식 모음 |
| KB증권 | `kb-research` | `collect-kb-research.mjs` | robots 없음(www·rdata 둘 다) |
| 교보증권 | `kyobo-research` | `collect-kyobo-research.mjs` | robots `User-agent: * Allow: /` |
| IBK투자증권 | `ibk-research` | `collect-ibk-research.mjs` | robots `User-agent: * Allow: /` |
| ~~KIRS(한국IR협의회)~~ | ~~`kirs-research`~~ (예약 중단, 수동만) | — | **2026-10-03 한경 컨센서스 경유로 대체**(오너 결정). 해외 IP 차단으로 오라클에서 못 받음. 한경에 기업분석은 실리지만(30일 20건 = 직접 20건) **기술분석(30일 10건)은 빠진다** |
| 유안타증권 | `yuanta-research` | `collect-yuanta-research.mjs` | robots 없음. 2026-09-25 직접 수집 재개(한경 경유에서 제외) |
| 대신증권 | `daishin-research` | `collect-daishin-research.mjs` | robots 없음(money2.daishin.com) |
| iM증권 | `im-research` | `collect-im-research.mjs` | robots 없음 |
| 메리츠증권 | `meritz-research` | `collect-meritz-research.mjs` | robots 없음 |
| 상상인증권(기업·산업) | `sangsangin-research`·`sangsangin-industry-research` | 같은 이름 | robots 파일은 있으나 규칙 없음 |
| DS투자증권 | `ds-research` | `collect-ds-research.mjs` | robots 없음 |
| 다올투자증권 | (오라클 타이머 `research-daol-research`, 2026-10-04 추가) | `collect-daol-research.mjs` | robots 사실상 제한 없음(`Diallow:/img/keditor` 오타 한 줄). 목록·PDF 로그인 불필요. **퀀트 게시판 제외**(오너 결정). PDF 다수가 글자 없는 이미지라 요약·의견·목표가는 글자 있는 PDF 에서만 |
| BNK투자증권 | ~~`bnk-research`~~(GitHub 예약 중단) → **사무실 PC 작업 스케줄러 `macro-research-bnk`**(08·10·12·14·16·18시 05분, 꺼져 놓친 회차는 켜지면 따라잡음) | `collect-bnk-research.mjs --days=3` | robots 없음. ⚠️ **해외 IP 차단** — GitHub(미국)·오라클(일본)·구글 서울 Cloud Run(나가는 IP 가 미국) 모두 실패, 한국 IP 만 됨. 실행 스크립트 `C:Userspost0macro-localnk-research.cmd`(5-master 작업 폴더 사용) |

빈도 결정: 2026-10-03 오너 — "로봇 제한이 없는 것은 6회로"(처음 6곳), 이어 robots 실측으로 옮겨 온 10곳도 "하루 6회로 결정".
robots 실측(2026-10-03, 수집기가 실제로 접속하는 주소 기준)으로 분류했다. CLAUDE.md 사이트별 항목의 "robots 차단·하루 1회"
기록은 승인 당시 판단이고 이 표가 최신이다.

### ①-2 국내 · robots 차단, 예외 승인 — 하루 6회 (08·10·12·14·16·18시)

| 소스 | 접속 주소 | robots |
|---|---|---|
| 신한투자증권 | bbs2.shinhansec.com | `User-agent: * Disallow: /` |
| 하나증권 | www.hanaw.com | 구글·네이버봇만 허용, 나머지 `Disallow: /` |
| NH투자증권 | www.nhsec.com | 일반 봇 `Disallow: /`, 일부 검색엔진만 허용 |
| 한국투자증권 | securities.koreainvestment.com | 일반 봇 `Disallow: /`, 검색엔진만 허용 |
| 한경 컨센서스 | consensus.hankyung.com | `User-agent: * Disallow: /` — 자체 수집 증권사는 제외하고 받는다(`EXCLUDED_SOURCES`). 2026-10-03 부터 한국IR협의회(KIRS)를 다시 포함 |

- robots.txt 는 "자동 수집을 원하지 않는다"는 사이트의 의사 표시일 뿐 접속을 기술적으로 막지는 않는다. 그래서 이 5곳도 실제로는
  받아진다. 이 프로젝트는 오너가 개인용·저빈도 조건으로 예외를 승인해 수집한다(CLAUDE.md 사이트별 항목). BNK·KIRS 처럼
  방화벽에서 해외 IP 를 막는 것은 robots 와 별개다.
- 빈도: 2026-10-03 오너 결정 — "봇 제한이 있는 곳은 일일 6번으로". 그 전은 2026-09-14 오너 지시로 하루 2회(커밋 6278730),
  그 이전 승인 기록은 하루 1회였다. 요청이 늘면 IP 차단 위험이 다른 곳보다 크므로 회차당 목록 몇 페이지만 받고, 사이트마다 실행 시각을
  몇 분씩 어긋나게 두며, 연속 실패는 감시 알림으로 올린다.

### ①-3 해외 IB·운용사 — 하루 1회

골드만삭스, JP모간, 모간스탠리, 블랙록, PIMCO, BNP파리바, 씨티, BofA Institute, HSBC, 도이치방크 리서치
— 공개 사이트맵(또는 게시판)과 글 페이지 메타. 인사이트 탭·산업분석 "해외리서치" 세그먼트로 나뉨. 빈도 확정(2026-10-03 오너).

### ①-4 일본 현지 — 하루 1회 (18:40)

| 소스 | 타이머 | 스크립트 | 비고 |
|---|---|---|---|
| FISCO 企業調査レポート | `research-fisco-research`(2026-10-10 정의, 설치는 배포 때) | `collect-fisco-research.mjs` | 오너 승인 2026-10-10. 목록 한 장(`www.fisco.co.jp/service/report/`, 로그인 불필요) 1요청. robots 는 wp-admin 만 차단. 사이트 정책(무단 복제·전재 금지, 링크 자유)에 따라 **날짜·회사명·종목코드·PDF 링크만** 저장(요약·본문 없음), 영어판 제외. market jp, category 기업, source "FISCO". 발행사 부담 스폰서드 리포트(중소형주 위주, 90일 약 178건) |

국내 증권사 수집기 중 일본 종목·일본 시장 글은 market jp 로 보낸다(2026-10-10 — 신한 해외·키움 CC·다올·미래에셋·NH, 수신 라우트가 종목코드 접미사 ".JP" 등을 뗀다).

---

## ② 거시경제

쓰는 화면: 거시경제 대시보드(글로벌 핵심지표·한국/미국 공포·탐욕·Fed 금리 확률 등), 주간 리포트 스냅샷.

### ②-1 예약 수집 → DB 저장 (스케줄 대상)

| 항목 | 소스 | 실행(이전 전) | 빈도 | 저장 |
|---|---|---|---|---|
| 외국인 코스피200 선물 순매수 | **다음 금융(카카오)** 투자주체별 동향 JSON — 2026-09-28 네이버(410 폐지)에서 교체 | **오라클 타이머 `macro-foreign-fut`**(2026-10-03 이전, `collect-foreign-fut.mjs` → 서버 안 `/api/cron/kr-fg`) | 하루 1회 06:31(KRX 배치와 1분 어긋남) | `kr_fg_daily` |
| 한국 공포·탐욕 원자료(전종목 일별매매·VKOSPI·옵션) | KRX OPEN API | ~~Vercel Cron~~ → **오라클 타이머 `macro-kr-fg`**(2026-10-03 이전) | **다음 날 06:30**(전 영업일분 — KRX OPEN API 는 다음 영업일에 공개). 휴장 판정은 공휴일 달력(`market-calendar.ts`). 2026-10-03 09-14~10-01 휴장 오기록 11일 백필 | `kr_fg_daily`·`kr_stock_roll`·`kr_index_daily` |
| 브라질 국채 NTN-F ~10년 롤링 수익률 — 중간값(주간 리포트 스냅샷, 4번과 같은 정의) | ① ANBIMA 지표금리 일일 파일 `anbima.com.br/informacoes/merc-sec/arqs/msYYMMDD.txt`(인증 없음, 약 4주치만 공개 → DB 누적) ② 브라질 재무부 Tesouro Transparente CKAN `precotaxatesourodireto.csv`(약 14MB, 매일 약 10:20 UTC 에 전 영업일분 갱신) (매수+매도)/2. 실시간 임시값은 안 씀 | **오라클 타이머 `macro-br-ntnf`**(2026-10-06 신설, `scripts/run/ntnf-daily.mts` → DB 직접) — 예전엔 4번 저장소(post0318/4) GitHub Actions 가 만든 JSON 을 읽었다 | 매일 07:10. CSV 는 **새 날짜만**(최근 2주 재확인, 기존 값 불변), ANBIMA 는 최근 35일 중 아직 anbima 가 아닌 날짜만(CSV 값 대체). 각 값에 `src`(anbima·csv-mid). 첫 실행 때 7년 백필. 최신값이 브라질 평일 3일 넘게 안 바뀌면 실패(→ `job-macro-br-ntnf` 알림) | `br_ntnf_daily`(1행/영업일, 7년 ≈ 0.3MB) |
| Fed 금리 확률 일별 스냅샷 | Kalshi | GitHub `fedwatch-snapshot` → `/api/cron/fedwatch` | 하루 1회 | DB |

한국 공포·탐욕은 화면 조회 때 빠진 영업일을 백그라운드로 보충하는 자가 복구가 있다(`lib/macro/kr/batch.ts`, 10분 쿨다운).

### ②-3 거시경제 DB 관리 (MongoDB Atlas, 2026-10-03 실측 크기)

| 컬렉션 | 내용 | 키 | 보관 | 크기 |
|---|---|---|---|---|
| `kr_fg_daily` | 거래일별 한국 공포·탐욕 원자료 1문서(상승·하락 종목수, 52주 신고·신저, VKOSPI, 풋콜, 외국인 선물 순매수, 베이시스) | `_id`=거래일 | **영구**(문서당 약 250B) | 4,141건 · 1.3MB |
| `kr_stock_roll` | 종목별 최근 252거래일 종가 롤링 창(52주 신고·신저 판정용) | `_id`=종목코드 | 종목당 1문서, 창 길이 고정 | 3,671건 · 6.5MB |
| `kr_index_daily` | 코스피·코스닥 일봉(종가·시고저·전일 대비·등락률). 과거분 2015~2020 + **2026-10-03 부터 일일 배치(06:30)가 매일 전 영업일분 저장** — 거시경제 한국 지수 스냅샷이 이 DB 를 읽는다 | `_id`=시장:날짜 | 영구 | 2,950건 · 0.4MB(하루 2건 추가) |
| `kr_fg_meta` | 배치 쿨다운 잠금·진행 커서 | 키 | 덮어쓰기 | 2건 |
| `fedwatch_daily` | Kalshi Fed 금리 확률 일별 스냅샷(전일·전주 비교용) | `_id`=수집일(UTC) | 영구(하루 1문서) | 62건 · 0.03MB |

- 쓰기는 모두 `_id` 기준 upsert(같은 날을 다시 받아도 덮어쓰기라 중복이 안 쌓인다). 과거분 백필은 이미 있는 날짜를 건드리지 않는다
  (`fedwatch_daily` `$setOnInsert`).
- ②-2(화면 조회형) 데이터는 DB 에 넣지 않고 서버 캐시(Next fetch revalidate)로만 둔다.
- 증가량: 하루 몇 문서·수 KB 수준이라 한도(512MB, 현재 전체 5.7%) 걱정이 없다. 전체 DB 크기는 `node scripts/db/size.mjs`.

### ②-2 화면 조회 때 가져오기 + 캐시 (스케줄 불필요)

캐시 원칙(오너 결정 2026-10-03): **일별 이상으로 바뀌는 데이터는 12시간**으로 통일. 장중에 움직이는 데이터는 따로 —
Yahoo(짧게), Kalshi(5분), CNN(1시간, 장중 갱신 주기 실측 뒤 결정). 한국 지수 스냅샷은 DB 에서 읽는다.

| 항목 | 소스 | 캐시 | 코드 |
|---|---|---|---|
| 미국·일본 지수, 원자재, 환율, 지수 차트 | Yahoo(`yahoo-finance2`, 개인용) | 짧게 | `lib/macro/indices.ts`·`index-chart.ts` |
| 한국 지수(코스피·코스닥 스냅샷·차트) | **스냅샷은 DB(`kr_index_daily`, 일일 배치가 저장)** — DB 가 5일 넘게 비었을 때만 KRX OPEN API 직접(캐시 1시간). 차트는 DB 과거분 + 금융위 지수시세(12시간) | 오너 결정 2026-10-03 — 하루 한 번 바뀌는 데이터라 화면이 KRX 를 매번 부를 필요가 없다 | `lib/macro/indices.ts` |
| 미국 거시 지표 | FRED | 12시간 | `lib/macro/fred.ts` |
| 국고채·회사채 금리 | 한국은행 ECOS | 12시간 | `lib/macro/kr/ecos.ts` |
| CNN 공포·탐욕 | CNN 비공식 API(예외 승인) | 1시간 | `lib/macro/feargreed.ts` |
| Fed 금리 확률(현재) | Kalshi(예외 승인) | 5분(2026-10-03 30분에서 단축) | `lib/macro/fedwatch.ts` |
| 미국 재무부 TGA 잔고 | 미 재무부 Fiscal Data | 12시간 | `lib/macro/tga.ts` |
| 한국 공포·탐욕 지수 | `kr_fg_daily` 에서 계산 | — | `lib/macro/kr/fear-greed.ts` |

---

## ③ 뉴스·SNS

쓰는 화면: 종목분석 "종목뉴스" 탭, 유니버스 통합 뉴스, 인플루언서(텔레그램) 화면, 주간 리포트 입력.

| 항목 | 소스 | 실행(이전 전) | 오라클 빈도 | 저장 |
|---|---|---|---|---|
| 종목뉴스 | 네이버 종목 태깅·뉴스 API(허브), Google 뉴스 RSS, Yahoo, 빅테크 공식 블로그 RSS | **오라클 타이머 `news-stock-news`** → `/api/cron/stock-news`(2026-10-04 재개) | 10분마다 깨움 — 한국 종목 장중 10분·미국 장중 30분·장외 1시간 지난 것만 | DB(`stock_news`). 판정은 규칙(`news-rules.ts`), 비용 0 |
| 텔레그램 채널 | Telegram API — **오라클 상주 수신기 `macro-telegram-listener`**(`scripts/listen-telegram.mjs`, 2026-10-03) | 새 글 **즉시**(텔레그램이 밀어줌) + 시작·30분마다 이어받기 | — | DB(`_id` upsert). GitHub `telegram-posts` 는 비활성화, **cron-job.org 재기동 작업은 꺼야 함**(같은 세션 동시 접속 시 끊김) |
| 네이버 블로그(인플루언서) | `rss.blog.naver.com/{blogId}.xml`(influencers.md 의 blog 항목, 블로그당 1요청, ETag 미제공) — 오라클 타이머 `news-naver-blog`(`scripts/run/naver-blog-poll.mts`) | **5분마다**, 새 글만(링크 기준 insert) | 오라클 | DB `naver_blog_posts`(제목·링크·발행시각만, 180일 TTL). 화면은 DB 만 읽음(비면 빈 목록) |
| 유튜브(인플루언서) | 유튜브 공식 새 영상 알림(WebSub) → `/api/webhooks/youtube` → DB `youtube_videos`. 구독 갱신·최신 10개 동기화는 오라클 타이머 `news-youtube-subscribe`(매일 05:00, 구독 10일) | 새 영상 **즉시** | — | 화면은 DB 먼저, 비면 공식 API(15분 캐시). 피드 라우트 캐시 1분 |
| 뉴스 제목 번역 | Google 번역 웹, MyMemory | 화면 조회 때 | — | 캐시 |

---

## ④ 종목분석 (재무·투자의견)

쓰는 화면: 종목분석(하이라이트·재무제표·멀티플·애널리스트 투자의견), 유니버스 통합 뷰. 재무 계산은 무거워서 한 번에 하나만 돌린다.

| 항목 | 소스 | 실행(이전 전) | 빈도 | 비고 |
|---|---|---|---|---|
| 애널리스트 투자의견(미국, 종목당 상위 5건) | StockAnalysis | GitHub `analyst-forecasts`(`collect-analyst-forecasts.mjs`) | 하루 1회 | 저장 `analyst_forecasts`(종목 단위 스냅샷 교체). 승인 조건 하루 1회·종목당 5행. 빈도 확정(2026-10-03 오너) |
| 애널리스트 컨센서스(일본) | みんかぶ `minkabu.jp/stock/{코드}/analyst_consensus`(서버렌더 HTML, JSON·XHR 없음) | 화면 조회 때(`/api/markets/jp/{코드}/minkabu`, `lib/markets/jp/minkabu.ts`) | 종목당 12시간 캐시(Next 데이터 캐시 + 메모리, 404·실패도 기억) | 크롤링 예외 5건(2026-10-09 오너 승인 — 개인용·적은 요청·캐시, 무료). **일본 IP 에서만 열림**(한국 IP 403). 레이팅·목표주가(머리 상자 = 평균 버림, 야후 7203.T 평균과 같음)·의견 분포·애널리스트 수·기준일·3개월/1개월/1주 전 변화·실적 예상(매출·순이익·EPS, 회사 예상 포함). 404 = 애널리스트 예상 없는 종목(1301 등), DB 저장 없음 |
| 재무 배치(fin-build) | SEC EDGAR | **오라클 타이머 `fin-fin-build`**(`ops/oracle/run-ts.sh fin-build.mts`, 2026-10-03 이전) | 하루 1회 06:10 | 새 정기공시·엔진판 변경 종목만 조립. SEC 캐시 `/opt/macro/sec-cache` 상시 보관(앱과 공유) |
| 미국 TTM 스냅샷(ttm-build) | SEC + 앱 계산 | **오라클 타이머 `fin-ttm-build`** + 배포 직후 `post-deploy.sh`(2026-10-03 이전) | 하루 1회 06:50 + 배포 직후(무효 저장본만) | 판번호 = 계산 판번호 `e{ENGINE_VERSION}.t{TTM_RULES_VERSION}`(커밋 아님, 2026-10-03 오너 결정) — 계산 규칙이 바뀔 때만 전 종목 재계산 |
| 새 유니버스 종목 미리 계산(precompute) | SEC(미국)·DART(한국) + 앱 계산 | **오라클 타이머 `fin-precompute`**(`ops/oracle/run-precompute.sh` → `run-ts.sh precompute.mts`, 오너 승인 2026-10-06) | 5분마다 — 대기열에 있을 때만 일함 | 유니버스에 **전 계정 처음 담긴** 종목만 대기열 `precompute_queue`(TTL 7일)에 → 미국 재무 조립·TTM(회차당 10종목, SEC 순차), 한국 감가상각 적재(`fin-kr-da` 설치 뒤, 회차당 5·24시간 30종목 — DART 운영 키 몫). 정기 배치(fin-fin-build·fin-ttm-build·fin-kr-da) 실행 중엔 쉼. 실패는 재시도 2회 뒤 failed(24시간 job 알림). 배치 분류 |
| 미국 복수 클래스 주식수 | SEC | ~~Vercel Cron~~ → **오라클 타이머 `fin-us-class-facts`**(2026-10-03 이전) | 분기 1회(1·4·7·10월 5일 15:00) | 다음 2026-10-05. 저장 `us_class_facts` |
| 일본 공시 색인(jp_docs) | EDINET API v2 공시 목록 | **오라클 타이머 `fin-jp-edinet-index`**(`run-ts.sh jp-edinet-index.mts --days=10 --no-samples`, 2026-10-09) | 하루 2회 08:30·20:30 | 상장사 재무 보고서 6종만 색인(건당 약 412B). 목록·원본 zip 은 `/opt/macro/edinet-cache`(앱과 공유). 첫 배포 때 `--days=1900` 으로 5년치 백필 |
| 종목 화면 재무·시세 | DART, SEC, KRX, EDINET, Yahoo | 화면 조회 때 | — | 디스크 캐시 |

---

## ⑤ 주간 리포트

| 항목 | 입력 | 실행(이전 전) | 빈도 |
|---|---|---|---|
| 초안 생성(`/api/cron/weekly-report`) | 위 DB(리서치·뉴스·텔레그램) + 시세 스냅샷(Yahoo·ECOS·브라질 SGS·브라질 NTN-F `br_ntnf_daily`) + 네이버 검색어 트렌드 + Gemini 코멘트 | 오라클 타이머 `weekly-report`(월~금 08:30 KST 깨움, 그 주 첫 한국 거래일에만 생성) | 주 1회 | DB(`weekly_reports`) |

한국 섹터는 KRX 지수(다음 거래일 07:55~08:00 게시)를 쓴다. 게시 전이면 "자료 없음"으로 비운다(앞 날짜 종가로 대체하지 않음, 2026-10-05). 생성 시각 08:30(2026-10-09).

발행은 자동이 아니다 — 오너가 `/weekly` 에서 검수 후 발행. Gemini 비용은 앱 예산 `WEEKLY_MONTHLY_BUDGET_USD`(10달러) +
구글 지출 상한 `guard-gemini`(13,000원).

---

## 수동 실행 전용 (예약 없음)

`gemini-grounding-check`, `news-relevance`, `normalize-sim`, `universe-overview-refresh`, `weekly-grounding-peek`,
`weekly-model-compare`, `weekly-weight-sim`, 배포(`deploy-oracle`·`deploy-cloudrun`).

## 합계

| 묶음 | 예약 작업 수 |
|---|---|
| ① 리서치 | 32 (국내 21 — KIRS 는 한경 경유 — + 해외 IB 10 + 일본 FISCO 1) |
| ② 거시경제 | 3 (다음 선물·KRX 공포·탐욕 원자료·Fed 스냅샷 06:00 — 오라클) |
| ③ 뉴스·SNS | 3 (텔레그램 상주 수신기·유튜브 구독 갱신·종목뉴스 — 오라클) |
| ④ 종목분석 | 5 (fin-build·ttm-build·precompute(5분)·us-class-facts·StockAnalysis 투자의견 10:20 — 오라클) |
| ⑤ 주간 리포트 | 1 |
| **합계** | **44** — 오라클 43(타이머 42 + 텔레그램 상주 수신기), 사무실 PC 1(BNK). GitHub 예약 0(2026-10-04) |
