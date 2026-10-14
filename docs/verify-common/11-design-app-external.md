# 설계 — ② 앱 읽기(공통) · ③ 외부 소스 어댑터(시장별) · ⑤ 외부값 정리 (2026-10-14, 승인 전)

**설계 문서다. 코드는 고치지 않았다(오너: "설계 승인 전 코드 착수 금지").** 오너 결정이 필요한 것은 "미결(오너 확인)"으로 표시했고, 결정을 지어내지 않았다.
같은 파이프라인의 다른 단계: ① 원자료 어댑터·④ 기대값 = `10-design-raw-adapters.md`, ⑥ 판정·⑧ 게시 = `12-design-judge-publish.md`, 사전 행 키 = `01-metric-dictionary.md`(각각 다른 작업자가 작성 중 — 이 문서는 그 이름만 참조한다).

읽은 근거:
- 문서: `00-handoff.md`(파이프라인 ①~⑨, 판정 가·나·다), `01-metric-dictionary-draft.md`(오너 결정 A·Q·C), `survey/*.md`, 실측 `03`~`09`, `memory/*.md`, `CLAUDE.md`(크롤링 금지·검증용 예외·재무 검증 체계).
- 코드(`git show`, 체크아웃·실행 없음): 앱 `origin/kr/app` fbe85df · `origin/jp/app` 8591851 · `origin/us/app` 4628227 · `origin/master` 2eca315,
  검증기 `origin/kr/verification` 7bf0515(미국·한국 최신 검증기) · `origin/jp/verification` eb84f37(일본) · `origin/us/verification` 4628227.
  아래 "파일:줄"은 괄호 안 브랜치 기준이다. 검증기 경로 `scripts/verify-financials.mjs` 는 VF 로 줄인다.

---

## 0. 세 단계의 자리와 공통 약속

```
① 원자료 어댑터 ─┐
② 앱 읽기 ───────┼─→ ④ 기대값(①만) ─┐
③ 외부 소스 ─→ ⑤ 외부값 정리 ───────┴─→ ⑥ 비교·판정 → ⑦ → ⑧ → ⑨
```

- ①·②·③ 은 서로의 출력을 읽지 않는다(독립 입력). ⑤ 는 ③ 의 출력만 정리하고 **앱 값(②)을 보지 않는다** — 외부값을 앱 값에 맞춰 고르는 일(여러 단위·기간 중 맞는 것 고르기)을 구조로 막는다. 앱 값과 맞추는 일은 ⑥ 이 한다.
- 칸 열쇠(모든 단계 공통): `시장 | 종목 | 화면 | 사전 행 키 | 기간` (00-handoff "칸 = 종목×화면×지표×기간"). 기간은 `{종류: fy|ltm|est|current, 기말일 YYYY-MM-DD, 시작일?}` — **라벨("2025Y", "FY2026")이 아니라 기말일로 맞춘다**(52/53주 결산·3월·8월 결산·한국 12-31 고정 표기 결함 A24 때문에).
- 값은 **원 단위 수치**(원·달러·엔·주·배·%)로만 주고받는다. 표시 단위(억원·백만·소수 자리)는 `표기 단위`로 따로 들고 다닌다. 반올림·버림을 단계 안에서 하지 않는다(CLAUDE.md "서버는 원값, 소수점 처리는 화면 `lib/format.ts`(버림)에서만").
- 모든 실패는 **기록 + 종료코드 1**(CLAUDE.md 재무 검증 원칙 3). 조용한 건너뜀·대체 금지(그림자 채우기 금지, `memory/feedback-no-shadow-fill.md`).

---

## ② 앱 읽기(공통)

### ②-1 입력

| 입력 | 내용 | 근거 |
|---|---|---|
| 대상 앱 서버 | 2호기 verify-dev(`http://localhost:3000`) **하나**. 운영 주소 금지 | CLAUDE.md "검증기 `--base` 를 운영 주소로 주지 말 것", `memory/feedback-verify-server-memory.md` |
| 앱 판본 | verify-dev 작업트리의 브랜치·HEAD·dirty 여부(`kr/app`·`jp/app`·`us/app` 중 시험 대상 시장의 것) | 00-handoff 브랜치 결정 |
| 종목 목록 | `--symbols` 또는 `/api/cron/universe-symbols?market=`(인증) | VF:186~190(kr/verification) |
| 인증 | `CRON_SECRET`(Bearer) 또는 `APP_PASSWORD`(`x-app-token`). 값은 로그·결과에 남기지 않는다 | VF:161(kr/verification), `verify-row/route.ts` authorized |
| 사전 매핑표 | 화면·응답 위치 → 사전 행 키·단위 종류(②-4) | `01-metric-dictionary.md`(작성 중) |

### ②-2 화면별 앱 API 경로

모두 `GET /api/markets/{market}/{symbol}/…` (앱 브랜치 세 개 모두 같은 라우트 파일 목록 — `src/app/api/markets/[market]/[symbol]/` 확인).

| 화면 | 경로 | 응답에서 읽는 곳 | 미 | 한 | 일 |
|---|---|---|---|---|---|
| 하이라이트(일반·금융) | `/highlights` | `highlights.columns[]{key,label,date,kind}`, `rows[]{key,format,values[],cellNotes[]}`, `valuationRows[]`, `notes[]`, `currency`, `unitLabel` | ○ | ○ | ○ |
| 재무분석 | `/financials?view=analysis` | `sections[].items[]{accountId("an:…"),accountName,values{열 라벨:값},cellNotes,numberFormat}`, `periods[]`, `unit`, `warnings` | ○ | ○ | ○ |
| 재무제표(하이라이트 연결용만) | `/financials?view=is|bs|cf|summary&period=annual|quarter` | 같은 구조 | ○ | ○ | ○ |
| 개요(시가총액 + 투자지표 10칸) | `/overview`, `/ttm`, `/api/cron/verify-row`(`overview.multiples`) | `TrailingMultiples{per,perTtm,pbr,psr,evEbitda,eps,bps,dividendYield,marketCap,reasons}`, TTM `dividend.annual/ttm.dps` | ○ | ○ | **✕(verify-row 가 us·kr 만)** |
| 유니버스 | `/api/cron/verify-row`(`universe` = `computeUniverseRow` 결과) | `{per,perTtm,estPer,pbr,forwardPer,targetMeanPrice,recommendationKey,marketCap,revenueAnnual,opMargin,netMargin,foreignRatio}` | ○ | ○ | **✕** |
| 컨센서스 | `/consensus` | `rows[]{fy,label,isEstimate,revenue,eps,opIncome,netIncome,bps,per,pbr,roe,evEbitda,revenueYoY,priceBasis,cellNotes}`, `epsRevision`, `earningsSurprise`, `targetPrice`, `recommendationMean` | ○ | ○ | ○(검증기 미호출) |
| 일본 민카부 카드 | `/minkabu` | 목표주가·레이팅·業績予想 | — | — | ○(검증기 미호출) |
| 지원 여부 | `/support` | `supported`(미국 모기지 리츠 제외) | ○ | — | — |

규칙:
- **화면에 그리는 값이 API 에 없으면 그 칸은 "앱 읽기 불가"로 기록한다(재현 계산 금지 — CLAUDE.md 원칙 4 "앱 계산을 재현하지 않는다").** 지금 그런 칸:
  - 개요의 PER(TTM)·추정PER·배당수익률은 화면 컴포넌트가 직접 계산한다 — `stock-analysis.tsx:463`(trailingPer)·`:479`(estPer)·`:493`(divYield)(kr/app). 일본 개요 시가총액 Yahoo 대체도 컴포넌트(`stock-analysis.tsx:703`, jp/app).
  - 일본 개요·유니버스: `verify-row` 가 `market=us|kr` 만 받는다(`verify-row/route.ts:78`, kr/app·jp/app).
  - 유니버스 화면 값은 DB 캐시(`universe_overview`)를 읽는다(`api/universe/overview/route.ts`, kr/app — 로그인 필요). `verify-row` 는 같은 함수로 **새로 계산한** 값이라 화면 캐시와 시점이 다를 수 있다. 한국만 검증기가 캐시 문서를 DB 에서 직접 읽어 따로 본다(K6, `verify-kr/layers.mjs:470~500`, kr/verification).
  → 읽을 경로를 앱에 만들지 여부는 **미결(오너 확인) M2**. C1 결정(개요 10칸 일본도 숨김)으로 10칸은 화면에서 사라지지만 값은 유니버스·요약 칩이 쓰므로 사전·검증 대상이다(01-draft C1).
- 컨센서스 연도별 BPS·PER·PBR·ROE·EV/EBITDA 는 화면 미표시지만 C2 결정("계산 유지, 정의 통일, 검증 대조 유지")에 따라 읽는다.
- 한 실행 안에서 경로마다 **한 번만** 부른다. 같은 응답을 여러 단계가 쓰면 저장한 응답을 쓴다.

### ②-3 저장본(스냅샷) 처리 — 헤더와 현재 상태

앱 GET 에는 저장본을 **읽고 쓰는** 경로가 있다(kr/app):
- 미국 하이라이트 `api_snap` 읽기·쓰기 — `highlights/route.ts:151`(read)·`:162`·`:168`(write); 24시간 안 저장본을 먼저 돌려준다(`db/api-snap.ts:25~35`).
- TTM `ttm_snap` 읽기·쓰기·조회 시각 기록 — `ttm/route.ts:32~49`, `markets/service.ts:118~128`.
- 미국 재무 저장본 `fin_sym` — 엔진판(ENGINE_VERSION)이 같으면 저장본을 그대로 쓴다(`lib/fin/index.ts:144~160`). 저장본에 "로컬/배포" 구분이 없다(api_snap·ttm_snap 은 `ttmSnapVersion()` 이 "local" 로 가른다, `db/ttm-snap.ts:34~39`).

검증기는 모든 요청에 인증 + `x-verify-no-snapshot: 1` 을 붙인다(VF:164~165, kr/verification·jp/verification). 앱 쪽 우회 코드 `src/lib/db/snap-bypass.ts`(인증된 요청이면 저장본 읽기·쓰기를 모두 건너뜀)는 **`kr/verification`·`jp/verification` 에만 있고 `kr/app`·`jp/app`·`us/app`·`master` 에는 없다**(`git grep x-verify-no-snapshot` 결과). 10-09 운영 배포(21ea0ba)에서 "검증 우회·한국 감사 코드 제외"로 일부러 뺐다(`memory/project-resume-20261009.md`).
→ 지금 앱 브랜치를 verify-dev 로 띄우면 헤더는 무시되고, 검증기는 (가) 2호기 DB 에 남은 24시간 안 "local" 저장본 (나) 매일 05:30 운영에서 복사된 `fin_sym`(운영 코드가 만든 값)을 읽을 수 있다 — **시험 대상 브랜치 코드의 계산이 아닐 수 있다.**

설계 규칙(어느 선택지든 공통):
1. 응답마다 "저장본을 우회했는가"를 증거로 남긴다. 앱이 그 사실을 응답에 싣지 않으면 `snapshotBypassed = 미확인` 으로 기록하고, 미확인 칸은 ⑥ 에서 "검증불가(앱 판본 불확실)"로 보낼지 ⑥ 설계가 정한다.
2. 선택지(오너 결정 필요 — **미결 M1**):
   - (가) 앱 브랜치 세 개에 `snap-bypass.ts` 와 호출부를 넣는다(인증 + 헤더일 때만 동작, 운영 동작 불변 — kr/verification 구현 그대로). 앱 코드 변경이다.
   - (나) 앱 코드는 두고, 실행 전에 2호기 **로컬** DB 의 대상 종목 `api_snap`·`ttm_snap`·`fin_sym` 문서를 지우고 verify-dev 를 `FIN_NO_PERSIST=1`(fin_sym 저장 거부, `fin/store.ts:234`)로 띄운다. 매일 05:30 복사가 다시 채우므로 실행 직전마다 해야 한다. api_snap·ttm_snap 쓰기는 막지 못한다(로컬 DB 에만 쓰임).
   - (다) 그대로 두고 저장본 사용 가능성을 "검증불가(앱 판본 불확실)"로만 표시.

### ②-4 응답 → 사전 행 키 매핑

- 매핑은 **데이터(표)**로 둔다: `{시장, 화면, 응답 위치, 앱 키} → {사전 행 키, 단위 종류}`. 앱 키:
  - 하이라이트 = `rows[].key`(+ `valuationRows`) — 예 `mktcap`·`ev`·`revenue_yoy`·`opinc_m`(survey/00-summary §1~2).
  - 재무분석 = `sections[].title` + `items[].accountId`(`an:{표시이름}`). **일본은 YoY·CAGR 행이 같은 accountId(`an:매출액`) — A16 결함**이므로 섹션 제목까지 합친 열쇠로 찾고, 한 섹션 안에 같은 열쇠가 둘이면 "매핑 모호" 실패.
  - 개요·유니버스 = 필드 이름(`per`, `perTtm`, `marketCap` …).
  - 컨센서스 = `rows[].{필드}` × `fy`/`isEstimate`, `epsRevision.{eps,per,epsNext,perNext}[i]`.
- 열 맞춤: 하이라이트 `columns[i].{kind,date}` → 기간 열쇠. 재무분석 `values` 의 키는 열 라벨이므로 `periods[]` 에서 라벨 → 기말일을 찾는다. 한국 연도 열 `date` 는 12-31 고정 표기(A24 — `dart-highlights.ts:91`, `dart-analysis.ts:542`)라 12월 외 결산 종목은 ① 의 결산일로 다시 맞춘다(②는 표기 그대로 싣고 `dateSuspect` 표시).
- 완전성(양방향):
  - 응답에 있는데 매핑표에 없는 행 → "사전 미등록 행" **실패**(화면에 나가는 값이 검증 대상에서 빠지면 안 된다).
  - 사전에 있고 그 시장·레이아웃에 있어야 할 행이 응답에 없음 → "행 없음" **실패**(행 유무 규칙은 사전이 정한다 — 예: 미국 하이라이트에 영업이익 행 없음은 사전의 시장별 행 구성).
  - 같은 행 키가 두 번 → 실패.
- `cellNotes` 는 값과 함께 그대로 싣는다(빈칸 사유·근사 라벨 — ⑥ 의 "기대 빈칸" 판정 재료).

### ②-5 단위

| 출처 | 규칙 |
|---|---|
| 금액(하이라이트·재무분석·컨센서스) | 원 단위 수치(원·달러·엔). `unitLabel`("KRW 십억"·"USD 백만"·"JPY 백만")은 **화면 표시 단위**일 뿐 값은 나누지 않은 수치다(`financial-highlights.tsx:15~27` 이 화면에서 ÷1e9·÷1e6 + 버림). 재무제표 응답은 `unit` 문자열을 읽는다 |
| `format: "pct"` | 퍼센트 수치(12.3 = 12.3%) — `dart-highlights.ts:74~76` `×100` |
| `format: "mult"`·`"eps"` | 배·통화 그대로 |
| 개요 배당수익률 | 화면 계산값이 **비율(0.012 = 1.2%)** — `stock-analysis.tsx:492~493` 주석. 하이라이트 `divyield`(퍼센트)와 단위가 다르다 |
| 미국 외화 공시 기업 | 앱은 USD 환산값(H.10 환율). 원통화 값은 응답에 없다 → ⑤ 의 통화 맞춤 규칙 |
| 단위를 모르는 필드 | 매핑표에 단위 종류를 적지 않은 필드는 값이 있어도 "검증불가(단위 미정)". 새 필드는 대표 1종목에서 ① 의 값과 크기(10^k)를 확인한 뒤 매핑표에 올린다 |

### ②-6 출력 스키마

```jsonc
// app-cells.jsonl — 한 줄 = 한 칸
{
  "run": "2026-10-20T0310+09:00-kr",            // 실행 ID
  "market": "kr", "symbol": "005930",
  "screen": "highlights",                        // highlights|analysis|overview|universe|consensus|minkabu
  "appKey": "rows:mktcap",                       // 응답 위치 + 앱 키(재무분석은 "섹션 제목#an:…")
  "dictKey": "<01-metric-dictionary 행 키>",
  "period": { "kind": "fy", "end": "2025-12-31", "label": "2025Y", "dateSuspect": false },
  "value": 1356336637056000,                     // 원 단위 수치 또는 null
  "unitKind": "money", "currency": "KRW",        // money|pct|ratio|fraction|mult|eps|shares
  "cellNote": null,
  "fetch": { "route": "/api/markets/kr/005930/highlights", "status": 200, "ms": 4120,
             "fetchedAt": "...", "file": "runs/<run>/app/kr-005930-highlights.json", "sha256": "...",
             "appCommit": "fbe85df", "appDirty": false, "snapshotBypassed": true|false|"미확인",
             "appWarnings": ["… 조회 실패 …"] }
}
```

- 응답 원문(JSON)은 실행 폴더에 저장한다(커밋 안 함). ⑥ 을 다시 돌릴 때는 저장한 원문으로 재생할 수 있어야 한다(같은 결과 = 같은 md5 — 실측 03~09 의 "두 번째 실행" 확인과 같은 방식).
- `appWarnings`: 응답 안의 경고 문구. 지금은 "조회 실패" 문구만 정규식으로 줍는다(`appFetchWarnings`, VF:3953~3956 kr/verification). 설계: 응답의 `warnings[]`·`notes[]` 중 "⚠"로 시작하는 것(일본, `highlights/route.ts` jp 분기)·`degraded`·`staleInputs`·`snapStale`·`staleEv` 필드를 모두 경고로 싣는다.

### ②-7 규칙 — 운영 DB 쓰기 금지 · verify-dev 운용(2호기)

운영 DB 쓰기 금지(`memory/feedback-verify-no-prod-writes.md`, 오너 2026-10-05):
- ② 는 GET 만 부른다. 그러나 위 ②-3 처럼 **앱 GET 이 DB 에 쓴다**(api_snap·ttm_snap·fin_sym·조회 시각). 그래서 verify-dev 의 DB 는 반드시 2호기 로컬 MongoDB(운영 매일 복사본)여야 한다.
- 실행 전 검사(검증기가 스스로, 하나라도 어기면 시작하지 않고 종료코드 2):
  1. verify-dev 환경 파일(2호기 `~/5/.env.local`)의 `MONGODB_URI` 호스트가 루프백(127.0.0.1·localhost)인가. Atlas(`mongodb+srv`·`*.mongodb.net`)면 중단.
  2. `--base` 가 `localhost`/`127.0.0.1` 인가.
  3. verify-dev 작업트리 브랜치가 시험 대상 시장의 앱 브랜치인가(아래 4), HEAD·dirty 기록.
  4. `free -m` available ≥ 2GB(`memory/feedback-verify-server-memory.md`).
- ② 이후 단계의 쓰기(⑧ `--post` → `/api/cron/verify-results`)는 이 문서 범위 밖(`12-design-judge-publish.md`). 단 ② 는 POST 를 부르지 않는다.

verify-dev 운용(2호기, 1코어 → 10-09 확장 CPU2·12GB, verify-dev High 2.5G·Max 3G):
- 앱 서버는 verify-dev(:3000) **하나**. 두 번째 `next dev` 금지.
- 검증기·빌드·측정 스크립트는 `flock /tmp/macro-verify.lock` 으로 한 번에 하나.
- 세 시장 앱 브랜치가 따로라, 시장마다 verify-dev 작업트리를 그 브랜치로 바꿔 띄운다 — **잠금 안에서, 한 시장씩**(동시 진행 금지, `memory/project-verification-order.md`). 앱 파일 교체는 잠금을 잡고 한 번에(`memory/feedback-verifier-precheck.md` — 제자리 수정 중 전 라우트 500 사고).
- 긴 실행은 묶음(10종목 안팎)으로 나누고 묶음 사이 verify-dev 재시작(`memory/feedback-dev-server-restart.md`). 요청 동시성은 지금 기본 2(VF:129 kr/verification) — 시작·묶음마다 메모리를 다시 재고 2GB 미만이면 멈추고 기록.
- DART·ECOS 등 키는 검증 전용 키(`memory/project-dart-shared-key-limit.md`) — verify-dev 가 앱 경로로 부르는 DART 요청도 검증 키 한도를 쓴다.
- 검증기 작업트리는 앱 작업트리와 분리(검증기는 `verify/common`, 앱 코드를 import 하지 않음 — 00-handoff "공통모드 방지").

### ②-8 실패 처리

| 상황 | 처리 |
|---|---|
| HTTP 오류·시간 초과(240초) | 그 경로의 모든 칸 "검증불가(앱 조회 실패)", 종목 `hardErrors`, 종료코드 1. 재시도는 1회(서버 재시작 직후 콜드 컴파일 대비), 결과에 재시도 사실 기록 |
| JSON 형식이 예상과 다름(필수 필드 없음) | 그 화면 전체 "검증불가(응답 형식)" + 실패 |
| `highlights: null` 등 빈 응답 | "앱 값 없음"으로 그대로 싣는다(⑥ 이 기대 빈칸 여부 판정). 검증불가로 바꾸지 않는다 |
| 응답 안 조회 실패 경고 | 칸 값은 그대로 싣고 `appWarnings` 로 넘김 + 종목 `hardErrors`(지금과 같음) |
| 매핑 미등록·모호·중복 | 실패(②-4) |
| 실행 전 검사 실패 | 시작하지 않음(종료코드 2) |
| 실행 중 메모리 2GB 미만 | 남은 종목 "검증불가(서버 자원)" 로 기록하고 멈춤 — 조용히 건너뛰지 않음 |

### ②-9 시험 방법

1. **심은 오류**: 앱 응답의 한 칸을 바꿔(지금 `US_VERIFY_TEST_MUTATE` VF:3963, `JP_VERIFY_TEST_APP` VF:11053 jp/verification 을 세 시장 공통 스위치 하나로) ② 출력에 그 값이 그대로 나오는지, 그리고 ⑥ 이 잡는지(⑨).
2. **매핑 완전성**: 대표 종목(시장·레이아웃별: 미 일반·은행, 한 일반, 일 일반·금융)의 저장 응답으로 "미등록 행 0·행 없음 0"을 확인. 행 하나를 지운 응답·이름을 바꾼 응답으로 실패가 나는지.
3. **저장본 우회 확인**(M1 선택 뒤): 로컬 DB 에 틀린 값을 넣은 `api_snap` 문서를 만들어 두고 ② 가 그 값을 받지 않는지(받으면 실패).
4. **운영 DB 차단**: `MONGODB_URI` 를 Atlas 형식으로 둔 환경 파일로 실행 전 검사가 멈추는지.
5. **재생 동일성**: 저장한 응답으로 두 번 돌려 출력 md5 같음.

### ②-10 지금 코드와 다른 점

| # | 지금 | 설계 | 위치 |
|---|---|---|---|
| a1 | `x-verify-no-snapshot` 을 보내지만 앱 브랜치에 받는 코드 없음 | 우회 여부 기록 + M1 | VF:164~165(kr/verification), `snap-bypass.ts`(kr/verification·jp/verification 에만) |
| a2 | 미국·일본 검증기 판본이 다름 — `us/verification` 은 헤더 자체가 없음, `kr/verification` 은 `--market=jp` 거부, 일본은 `jp/verification` 따로 | 하나의 검증기(`verify/common`) | VF:148(us/verification), VF:128(kr/verification), VF:130(jp/verification) |
| a3 | 일본은 하이라이트·재무분석·재무제표·TTM 만 읽음(개요·유니버스·컨센서스 안 읽음) | 세 시장 같은 화면 목록 | VF:11049(jp/verification) |
| a4 | 앱 판본(verify-dev HEAD) 기록 없음 — 검증기 자기 커밋만 | `appCommit`·`appDirty` 기록 | VF:133~140(kr/verification) |
| a5 | 경고 수집이 "조회 실패" 문구 정규식뿐 | ②-6 경고 필드 전부 | VF:3953~3956(kr/verification) |
| a6 | 실행 전 메모리·DB 주소·잠금 검사가 코드에 없음(작업자 지시로만) | 실행 전 검사 4가지 | VF 전체(검색 결과 없음) |
| a7 | 한국 K6·감가 적재본을 Mongo 에서 직접 읽음(DB 이름 `market_research` 하드코딩) | 읽기 전용 허용, 같은 루프백 검사 적용 | `verify-kr/layers.mjs:96~104·470~478`(kr/verification) |
| a8 | `verify-kr-fnguide.mjs` 가 종목 목록을 Mongo 에서 직접 읽음 | 종목 목록은 `universe-symbols` 하나 | `verify-kr-fnguide.mjs:18~25`(kr/verification) |

---

## ③ 외부 소스 어댑터(시장별)

### ③-1 공통 계약

- **허용 목록 방식**: 어댑터는 아래 표 "허용"인 호스트·경로만 부른다. 목록 밖 호스트 요청은 코드에서 거부(실패). 차단·robots 금지 사이트는 **우회하지 않는다**(헤드리스 브라우저·WAF 우회·비공개 API 금지 — 08 실측 원칙과 같음).
- **용도 한정**(CLAUDE.md 크롤링 금지 예외, 오너 2026-09-23·24): 외부 값은 검증 스크립트 안에서만 쓰고 앱 배포본·수집기·운영 DB 에 넣지 않는다. 결과에는 판정·차이와 증거 위치만 남긴다.
- ③ 은 **받기와 판독만** 한다(값을 원문 그대로, 원문 단위 그대로). 기간·단위·정의 정리는 ⑤.
- 입력: `{시장, 종목, 소스, 필요 항목 목록, 기준일(KST 날짜)}`. 종목 코드 변환(티커 ↔ `.KS/.KQ/.T`, FnGuide `cmp_cd`)은 어댑터 안에서 하되 **응답의 종목 코드를 반드시 확인**(FnGuide 는 잘못된 파라미터면 삼성전자를 준다 — VF:3562~3566 kr/verification).

출력 스키마:
```jsonc
// ext-raw.jsonl — 한 줄 = 소스가 실은 값 하나(원문 그대로)
{
  "source": "fnguide.invest",                 // 소스 ID(③-2 표)
  "lineage": "FnGuide",                       // 데이터 계보(③-5) — 독립성 계산용
  "market": "kr", "symbol": "005930",
  "srcKey": "invValueIndex/GRP3/EV",          // 원문 안 위치(JSON 경로·표 행 이름·열)
  "srcLabel": "EV",                           // 화면 표기 그대로
  "periodRaw": "2025/12",                     // 원문 기간 표기 그대로
  "valueRaw": "4,123,456.78",                 // 원문 문자열 그대로
  "unitRaw": "억원",                          // 원문/문서로 확인한 표기 단위
  "evidence": { "url": "...", "fetchedAt": "...", "httpStatus": 200, "file": "ext-cache/...", "sha256": "...", "fromCache": true }
}
// 값이 없는 칸도 남긴다: { ..., "valueRaw": null, "absent": "소스에 행 없음|기간 열 없음|빈칸 표시('－')" }
```

### ③-2 시장별 소스 · 접근 · 제약

(상태: **허용** = 오너 승인 근거 있음, **미결** = 오너 확인 필요, **제외** = 차단·robots·로그인 — 계획하지 않음)

**미국**

| 소스 ID | 접근 | 제약·근거 | 상태 |
|---|---|---|---|
| `yahoo.fts` · `yahoo.qs` | `yahoo-finance2` 라이브러리(fundamentalsTimeSeries 연·분기·trailing, quoteSummary earningsTrend·financialData·defaultKeyStatistics, chart 분할) | 앱 L2·L4 원천과 같은 라이브러리(개인용). **앱 추정치·시세의 원천이기도 하다** → 같은 항목은 독립 외부가 아님(③-5) | 허용 |
| `stockanalysis` | `stockanalysis.com/stocks/{t}/financials/{is|bs|cf}/__data.json`(브라우저 UA, devalue 평탄화) | 오너 2026-09-24 "검증 스크립트에만". robots 는 `/e/`·`/p/` 만 막음, ToS 는 전재 금지·출처 표기(CLAUDE.md). 원문 재게시 안 함 | 허용 |
| `infomax` | `globalmonitor.einfomax.co.kr/facset/*` POST(키 데이터·재무·주식수) | FactSet 계보. robots.txt 없음(CLAUDE.md). 인포맥스 **단말** 항목은 접근 수단 없음(03 "못 봄") | 허용 |
| `bbg` | 오너가 준 FA 스냅샷 판독 파일 `.cache/bbg/{종목}.json`(`scripts/reference/bbg-import.mjs`) — 네트워크 요청 없음 | 라이선스 데이터, 저장소에 올리지 않음(bbg-import 주석). 미국 46종목·10-07 스냅샷(LRCX 없음) | 허용(오너 2026-09-28 정식 소스) |
| MarketScreener·인베스팅닷컴 | — | 봇 차단(403), 스크립트 불가 — 불일치 칸만 사람이 브라우저로 확인(CLAUDE.md) | 자동 제외(③-7 수동 입력은 미결 M9) |

**한국**

| 소스 ID | 접근 | 제약·근거 | 상태 |
|---|---|---|---|
| `fnguide.invest`·`.finance`·`.snapshot`·`.consensus` | `wcomp.fnguide.com/CompanyInfo/{Invest|Finance|Snapshot|Consensus}?cmp_cd=` 서버렌더 HTML 안 JSON(옛 `comp.fnguide.com/SVO2` 폐지) | **robots `Disallow: /` + "무단 사용·DB화 시 민형사상 책임" 문구**(01-draft §6). 오너 2026-09-23·24 "검증용으로만 조회, 검증 스크립트 자동 대조 허용, 횟수 제한 없음". 원문을 디스크에 모아 두는 것(③-3 캐시)이 "DB화"에 해당하는지, Consensus·Snapshot 까지 범위를 넓히는지는 결정된 적 없음 | 조회 허용 / **보관·범위 미결 M3** |
| `naver` | `m.stock.naver.com/api/stock/{코드}/{finance/annual|integration}` | **앱 원천**(하이라이트 추정 열·유니버스 추정PER·외국인지분율 — `kr/naver.ts`, CLAUDE.md 예외). 네이버 기업분석 = FnGuide 제공(03: 29/29 칸 FnGuide 와 같음, 사사오입) → FnGuide 와 **같은 계보**. `finance.naver.com` 은 robots `Disallow: /`(별도 예외만) | 허용(원천 읽기용) |
| `wisereport` | 네이버 WiseReport(한국 현금성자산 정의 출처, CLAUDE.md B16) | 접근 경로·robots 문서에 없음(미확인) | **미결 M4** |
| `yahoo.fts`(.KS/.KQ) | 위와 같음 | 앱 FY2 추정(Q6 결정) 원천이기도 함 | 허용 |
| 인베스팅닷컴 | — | 봇 차단, 오너 2026-09-24 "대조군 포함"이나 브라우저 개별 확인만 | 자동 제외(M9) |
| 인포맥스 단말 | — | 2호기 접근 수단 없음(03) | 제외 |

**일본**(2호기 = 일본 IP. 한국 IP 는 민카부 403)

| 소스 ID | 접근 | 제약·근거 | 상태 |
|---|---|---|---|
| `yahoojp` | `finance.yahoo.co.jp` 종목·財務·業績予想 페이지(페이지에 박힌 RSC 데이터) | 오너 예외 5(2026-10-08~09) "검증 외부 대조" 명시 | 허용 |
| `minkabu` | `minkabu.jp/stock/{코드}/{settlement|analyst_consensus}` | 오너 예외("민카부 예외로 둔다" — 컨센서스 카드용). robots `/stock/` 허용. **검증 대조 용도까지 포함하는지는 문서에 없음**. 앱 민카부 카드의 원천이기도 함 | 컨센서스 허용 / 검증 대조 **미결 M5** |
| `kabutan` | `kabutan.jp/stock/finance?code=` | robots `Crawl-delay: 3`(08 실측). CLAUDE.md 승인 목록에 없음 — 08 측정에서만 사용 | **미결 M5** |
| `yahoo.qs`·`yahoo.fts`(.T) | yahoo-finance2 | 앱 일본 추정치 원천(earningsTrend)·시세 원천 | 허용 |
| `shikiho.help` | `help.toyokeizai.net` 정의 문서(값 아님) | 정의 근거로만 | 허용(정의 확인용) |
| 会社四季報オンライン 값 | — | SPA, 비공개 API 쓰지 않음(08) | 제외 |
| IFIS 株予報 | — | robots `crawl-delay: 72000` | 제외 |
| バフェット・コード | — | AWS WAF 사람 확인(08) — 우회 금지 | 제외 |
| IR BANK | — | CloudFront 403(08) | 제외 |
| 日経 | — | robots 가 ClaudeBot·Claude-User 를 `Disallow: /` | 제외 |
| SBI·マネックス | — | 로그인 필요 | 제외 |

(EDGAR·DART·EDINET·KRX·공공데이터포털·FRED H.10 은 ① 원자료 — 이 문서 범위 밖.)

### ③-3 지표별 "유효한 독립 비교" — 실측으로 확인된 것만

표의 "정의"는 ⑤ 의 정의 표시 기본값이 된다. **같음** = 실측으로 앱 정의(오너 결정 반영)와 같다고 숫자로 확인, **다름(식)** = 다르지만 줄 단위 분해식이 있음, **다름** = 정의가 다름(참고), **미실측** = 확인 안 함(⑤ 에서 "정의 미확인" — 일치해도 독립 근거로 세지 않을지 ⑥ 이 정함).

**한국**

| 지표(사전) | 소스 | 정의 | 근거 |
|---|---|---|---|
| 시가총액(보통주) | FnGuide Snapshot 「시가총액(보통주)」·네이버 | 같음 — 종가 × 상장주식수(자기주식 미차감) 30/30 | 04 |
| CapEx | FnGuide 「CAPEX = (C/F)유형자산의증가」 | 같음(Q12 유형) | 03 §4 |
| CapEx | Yahoo `capitalExpenditure` | 다름 — 유형 + 무형(`purchaseOfIntangibles` 총액) | 03 §4 |
| 매출·EBITDA·순이익(지배) | FnGuide Invest·Finance | 미실측(현 검증기가 대조 중 — VF:11376~11400 kr/verification) | — |
| EV | FnGuide | 다름(식) — FnGuide EV 는 비지배지분 제외: 앱 EV − FnGuide EV = 비지배지분(FnGuide 재무상태표와 일치할 때) | VF:11383~11388(kr/verification) |
| EPS | FnGuide·네이버 | 다름 — 지배순이익 ÷ 수정평균발행주식수(앱 = DART 공시 희석 EPS) | 04 참고·07 |
| BPS·PBR | FnGuide | 다름 — BPS 분모 = 수정기말발행주식수(자사주 차감) | 04 |
| PER(사업연도) | FnGuide 투자지표 | 기간 기준 같음(수정주가 ÷ 수정EPS = 오너 10-14 "액분은 수정기준") · EPS 정의 다름 | 07 |
| ROE | FnGuide | 같음(지배 순이익 ÷ 평균 지배 자본 = A2) | 01-draft A1·A2, CLAUDE.md 10-12 |
| ROA | FnGuide | 같음(연결 순이익 ÷ 평균 자산 = A1 "ROA(연결)") | 동 |
| 부채비율 | FnGuide | 같음(부채 ÷ 자본총계 = Q1 한국) | 동 |
| 이자보상배율 | FnGuide | 산식 같음(영업이익 ÷ 이자비용(비영업)) · 이자비용 범위(리스·계약부채 이자) 미실측 | CLAUDE.md Q2 |
| 배당성향 | FnGuide 「현금배당성향」 | 같음(결산 배당 ÷ 지배 순이익 — 10-14 결정) | 07 |
| 현금성자산·EV 현금 | WiseReport | 앱 정의의 출처(B16) — "기타유동금융자산" 회사별 차이 남음 | CLAUDE.md B16 |
| 추정 매출·영업이익·순이익·EPS·목표주가·투자의견(FY1) | 네이버 = FnGuide | **앱 원천** — 독립 외부 아님 | 03 Q14 |
| 〃 | Yahoo(0y) | 다름 — 다른 집계(기관 수·값 다름, 영업이익 없음, 투자의견 척도 반대) | 03 Q14 |
| 추정 PER(Fwd 12M) | FnGuide 「PER(Fwd.12M)」 | 다름 — FnGuide FY1·FY2, 앱은 FY1 네이버 + FY2 Yahoo(Q6 재결정) | 01-draft Q6 |

**미국**

| 지표 | 소스 | 정의 | 근거 |
|---|---|---|---|
| CapEx | StockAnalysis `capex` | 같음(유형 줄) | 03 §4 |
| CapEx | 블룸버그 「자본지출」 | 같음(회사 본표 유형 줄, 188칸) · CAT 만 다름(식) — 유형 + `PaymentsToAcquireEquipmentOnLease` | 03 §5 |
| CapEx | Yahoo | 다름 — 유형 + 무형 | 03 §4 |
| 매출·순이익·영업이익 등 손익 | Yahoo·StockAnalysis·인포맥스·블룸버그 | 현 검증기 F층 분류표(①·②식·외부 단독 이탈·③) 대상. 인포맥스 = **원공시 판본**(앱 = 최신 판본 — 다름(식): "원공시 vs 재작성") | CLAUDE.md, `memory/project-financial-architecture.md` |
| 감가상각비 | Yahoo·인포맥스 | 다름(식) — 운용리스 사용권자산 상각 포함(PEP) | CLAUDE.md 감가상각 |
| 감가상각비 | StockAnalysis | XOM 손상 차감 — 다름(식) | CLAUDE.md |
| 총차입금/자기자본 | Yahoo·StockAnalysis | 같음(연결 차입금 ÷ 지배 자본 — LVS 17.04 정확) | CLAUDE.md Q1 |
| 결산일 시가총액·현재 주식수 | 인포맥스 | 시가총액 센트 단위 · 주식수 천 주. "ev희석화수량"은 현금 미차감으로 보여 **대조 제외** | CLAUDE.md, VF:7905~7906 |
| 추정치(EPS·매출 0y/+1y)·forwardPE·목표주가 | Yahoo | **앱 원천** — 독립 외부 아님 | 01-draft Q6 |

**일본**

| 지표 | 소스 | 정의 | 근거 |
|---|---|---|---|
| 현금성자산(EV·순차입금) | 株探 「現金等残高」·みんかぶ 「現金期末残高」 | 같음 — CF 「現金及び現金同等物 期末残高」(10/10) = Q3 재결정 | 08 |
| 현금성자산 | Yahoo.com `cashAndCashEquivalents` | 다름 — BS 현금 줄(J-GAAP 現金及び預金) | 08 |
| 현금성자산 | Yahoo.com C&CE+STI | 다름 — 유동 その他の金融資産 포함 | 08 |
| 총차입금(리스 포함) | Yahoo!ファイナンス 「有利子負債」 | 정의 같음(IFRS リース負債·J-GAAP リース債務 포함, 31종목 중 23 정확) · 회사별 줄 누락 있음(ソニー 長期借入債務, NTT, JR東海 中央新幹線, 味の素 社債) | 08 §3 |
| 총차입금 | 株探 有利子負債倍率 | 리스 포함 쪽만 맞음(8058·9984 4칸). 배율이라 금액 역산은 자기자본 정의에 의존 | 08 |
| 총차입금 | Yahoo.com `totalDebt` | 대부분 앱과 같음(8058 2026-03 불일치 원인 미확인) | 08 |
| 총차입금 | 四季報 정의 | 다름 — 리스 제외(값은 접근 불가) | 08 |
| EV | 공개 사이트 값 없음(Yahoo.com `enterpriseValue` 는 현금 정의 다름) | 외부 없음 | 08 |
| 추정 EPS·매출 FY1·FY2 | Yahoo earningsTrend | **앱 원천** | 08 Q6 |
| 추정 FY1 | みんかぶ·Yahoo!ファイナンス(IFIS) | 다름 — 다른 집계, FY1 만(IFIS 는 EPS 없음) | 08 Q6 |
| 그 밖 손익·배당·주당 값 | — | 미실측(일본 검증기에 외부 층 없음) | jp/verification |

### ③-4 캐시 — "한 번만 받는다"

원칙(`memory/feedback-process-only-new.md` — 10-10 재발 지적 "이미 받은 것은 디스크에서, 다시 묻는 것은 바뀌었을 수 있는 것만 정해진 주기로, 실패 응답도 기억"):

- 위치: 2호기 디스크 `~/verify-ext-cache/<소스 ID>/<종목>/<요청 열쇠>/<수집 KST 날짜>.{body,meta.json}`(커밋 안 함). `meta.json` = URL·요청 헤더(인증값 제외)·HTTP 상태·수집 시각·sha256.
- **실패·차단·빈 응답도 저장**(`.status` — 08 `lib.py` 방식). 같은 주기 안에서는 다시 묻지 않는다.
- 재수집 주기(제안 — 승인 대상):
  | 종류 | 다시 받는 때 |
  |---|---|
  | 실적 재무(연도·분기 표) | 그 종목에 새 정기공시가 생겼을 때만(① 이 아는 최신 접수번호가 바뀜) + 마지막 수집 후 그 사이트 반영 지연을 고려해 공시 뒤 첫 실행 1회 더 |
  | 시세 기반 값(시가총액·PER·EV) | 비교할 앱 칸의 가격 기준일과 같은 거래일 값이 캐시에 없을 때만 |
  | 추정치·목표주가 | 실행일(KST) 기준 하루 1회 |
  | 정의 문서(도움말·화면 정의문) | 수동 갱신(자동 재수집 없음) |
- 옛 수집분은 지우지 않는다(같은 날짜 파일 덮어쓰기 없음) — 원자료 캐시 오너 결정(10-11: 검증 로직이 지우지 않음, 옛 판본 보관, 5GB 초과 때만 오래 안 쓴 것부터 + 건수 기록)을 외부 캐시에도 같은 규칙으로 쓴다(제안). **FnGuide·블룸버그 원문 보관은 M3·M8 결정 전까지 보관 기간을 정하지 않는다.**
- 매 실행 결과에 "소스별 외부 요청 수(성공·실패·캐시)"를 남기고, **두 번째 실행의 외부 요청 수가 0 에 가까운지**를 시험 항목으로 둔다(실측 03~09 의 방식).

### ③-5 데이터 계보(독립성 계산용)

00-handoff 다. "공통모드 + 독립 외부 2곳 이상 정확 일치"의 "곳"은 **계보 단위**로 센다(제안 — 미결 M6 에서 확정):
| 계보 | 소스 |
|---|---|
| FnGuide | `fnguide.*`, `naver`(기업분석·컨센서스 — 03 에서 같은 값 확인) |
| FactSet | `infomax` |
| Bloomberg | `bbg` |
| Yahoo(원 공급사 미확인) | `yahoo.*`(.com·.KS·.T) |
| StockAnalysis(원 공급사 미확인) | `stockanalysis` |
| 일본 현지 각 사 | `kabutan`, `minkabu`, `yahoojp`(業績予想는 IFIS 집계) |
- **앱 원천과 같은 소스는 그 항목에서 독립 외부가 아니다**: 한국 추정 FY1(네이버), 한국 FY2·미·일 추정(Yahoo), 일본 민카부 카드(민카부), 한국 외국인지분율(네이버), 시세(Yahoo·KRX). 이 칸에서 그 소스와 맞는 것은 "원천 확인"이지 독립 일치가 아니다.
- Yahoo·StockAnalysis 의 원 공급사가 같은지(둘 다 같은 데이터 회사에서 받는지)는 확인 안 됨 — 같다면 둘을 한 곳으로 세야 한다(M6).

### ③-6 요청 간격

| 호스트 | 간격(순차, 동시 1) | 근거 |
|---|---|---|
| wcomp.fnguide.com | ≥ 1초 | 04·07 실측 방식 |
| stockanalysis.com | ≥ 2초 | CLAUDE.md(애널리스트 수집 2초) |
| kabutan.jp | ≥ 3초 | robots `Crawl-delay: 3` |
| 그 밖 일본 호스트(minkabu·finance.yahoo.co.jp) | ≥ 1.5초 | 08 `lib.py` |
| m.stock.naver.com | ≥ 1초(제안) | 앱이 같은 API 를 운영에서 부름 — 검증이 운영 한도를 나눠 쓰지 않게 작게 |
| globalmonitor.einfomax.co.kr | ≥ 1초(제안) | — |
| yahoo-finance2 | 순차 | 08: 47건 오류 0 |
- 429·403 을 받으면 그 호스트는 그 실행에서 멈춘다(재시도로 밀어붙이지 않음) — 남은 칸 "외부 없음(호스트 차단 응답)" + 기록.
- 브라우저 UA 는 지금처럼 쓰되(StockAnalysis·FnGuide 는 없으면 확인 페이지 — VF:3528~3531), 로그인·쿠키·WAF 통과 수단은 쓰지 않는다.

### ③-7 실패 처리

| 상황 | ③ 출력 | 판정 쪽 의미 |
|---|---|---|
| 네트워크 오류·시간 초과·5xx | `absent: "조회 실패"` + 오류 원문, 실행 `hardErrors` | 그 소스 "외부 없음(조회 실패)" — 통과 근거로 안 씀, 종료코드 1 |
| 403·WAF·robots 금지 발견 | `absent: "차단"`, 그 호스트 중단 | 같음. 허용 목록 재검토 대상으로 보고 |
| 200 이지만 확인 페이지·형식 변경 | `absent: "형식 변경"` + 원문 저장 | 같음 + 어댑터 수리 필요 표시 |
| 응답 종목 ≠ 요청 종목 | 그 응답 전부 폐기, 실패 | 같음 |
| 소스에 그 행·그 기간 없음, 「－」 표시 | `absent: "소스에 값 없음"` | "외부 없음" — 조회 실패와 구분 |
| 수동 확인(인베스팅닷컴 등) | 자동 출력 없음. 사람이 확인한 값을 넣는 형식은 M9 | — |

### ③-8 시험 방법

1. **판독 고정 시험**: 실측 03~09 때 2호기에 저장한 원문(`~/5/reports/q12-q14/raw/sites/…`)을 입력으로 어댑터를 돌려, 문서에 적힌 값(예: FnGuide 삼성전자 시가총액 13,563,366억, 株探 キーエンス 451,269, Yahoo IBM CapEx 1,972)이 그대로 나오는지.
2. **두 번째 실행 외부 요청 0**: 같은 종목으로 두 번 실행해 두 번째 외부 요청 수·출력 md5 비교.
3. **허용 목록**: 목록 밖 호스트(예: irbank.net)를 부르는 어댑터 설정이 시작 단계에서 거부되는지.
4. **실패 기억**: 실패 응답이 저장되고 같은 주기에 다시 요청하지 않는지(가짜 서버로 403 을 주고 요청 수 확인).
5. **종목 확인**: 다른 종목 응답을 주는 가짜 응답으로 폐기·실패가 나는지.

### ③-9 지금 코드와 다른 점

| # | 지금 | 설계 | 위치 |
|---|---|---|---|
| e1 | StockAnalysis·FnGuide·Yahoo·인포맥스 응답을 디스크에 저장하지 않음 — 실행마다 다시 받음(SEC 원문·FX 만 캐시) | ③-4 캐시 | VF:3504~3615(kr/verification) 받기 함수들, 캐시는 VF:232~238(SEC)·3661(FX) |
| e2 | 일본 검증기에 외부 대조 층 없음(Yahoo 는 분할·일봉만) | 일본 어댑터(③-2) | `verify-jp/layers.mjs:64~83·334·629`(jp/verification) |
| e3 | 한국 외부 = FnGuide·Yahoo 만, 네이버(앱 원천)·WiseReport 없음 | 원천 읽기·M4 | VF:11372~11437(kr/verification) |
| e4 | 한국 FnGuide·Yahoo 실패가 `review` + `hardErrors` 문자열로만 남음, 칸 단위 "외부 없음(조회 실패)" 없음 | 칸 단위 기록 | VF:11405~11408·11437~11440(kr/verification) |
| e5 | `verify-kr-fnguide.mjs` Yahoo 실패를 조용히 넘김(`catch { /* 다음 접미사 */ }`), 결산 12월(`/^\d{4}\/12$/`)만 읽음 | 실패 기록, 결산월 일반화 | `verify-kr-fnguide.mjs:37·56`(kr/verification) |
| e6 | 블룸버그 스냅샷 날짜와 앱 열의 공시일을 비교하지 않음 — 스냅샷보다 늦은 공시 열이 섞임(03 §5: MU FY2026 "예상치 열") | 증거에 스냅샷 날짜, ⑤ 에서 기간 확인 | `reference/bbg.mjs:21~40` |
| e7 | 호스트별 간격·허용 목록이 코드에 없음 | ③-1·③-6 | VF 전체 |

---

## ⑤ 외부값 정리

### ⑤-1 입력·출력

입력: ③ 의 `ext-raw.jsonl` + ① 이 정한 종목 결산 정보(결산월, 사업연도별 기말일 — 앱 값이 아니라 원자료 기준) + 사전(`01-metric-dictionary.md`)의 행 정의·단위 종류. **② 앱 값은 입력이 아니다**(0 장).

출력:
```jsonc
// ext-values.jsonl — 한 줄 = (칸 열쇠, 소스) 하나
{
  "market": "kr", "symbol": "005930", "dictKey": "<사전 행 키>",
  "period": { "kind": "fy", "end": "2025-12-31", "how": "FnGuide 2025/12 = 결산월 12 → 2025-12-31" },
  "source": "fnguide.invest", "lineage": "FnGuide", "appSource": false,   // appSource = 그 항목의 앱 원천과 같은 소스
  "value": 412345678000000,            // 원 단위 수치(통화 그대로)
  "currency": "KRW",
  "unitKind": "money",
  "display": { "unit": 1e8, "rounding": "half-away" },   // 소스 표기 단위·반올림 방식(⑥ 의 반올림 식 재료)
  "def": { "tag": "다름(식)", "why": "EV 비지배지분 제외", "formula": "app.ev - ext.ev == app.nci", "ref": "VF:11383(kr/verification)" },
  "priceDate": null,                   // 시세 기반 값이면 가격 기준일
  "status": "ok",                      // ok | 외부 없음(…) | 기간 맞춤 실패 | 단위 미정
  "evidence": { "raw": "<ext-raw 줄 id>", "file": "...", "sha256": "...", "srcKey": "...", "valueRaw": "...", "periodRaw": "..." }
}
```

### ⑤-2 기간 맞춤

| 경우 | 규칙 |
|---|---|
| 사업연도 이름 | 소스 표기를 **기말일**로 바꾼 뒤 ① 의 그 사업연도 기말일과 ±7일 안이면 같은 기간(52/53주 결산 — WEN, 지금 VF:7974 `dayDiff ≤ 7` 과 같음). 이름("FY2026")끼리 맞추지 않는다 |
| 3월·8월 결산(일본 대부분·9983, 한국 일부) | FnGuide `YYYY/MM`, 네이버 `YYYY.MM`, Yahoo `date`·`endDate`, 株探·みんかぶ 「YYYY.MM」 모두 월을 읽어 기말일로. 일본 앱 FY 이름 = 기말 연도(3월 결산 FY2026 = 2026-03 기말, 05 문서) |
| 한국 앱 12-31 고정 표기(A24) | ⑤ 는 앱 라벨을 보지 않으므로 영향 없음 — ① 의 결산일로 맞춘다. 앱 쪽 표기 결함은 ⑥·⑦ 이 따로 잡는다 |
| LTM | 소스 LTM 의 **마지막 기간말**이 ① 이 정한 앱 LTM 기준(미·한 분기말, 일 반기말 — survey §0)과 같을 때만. FnGuide 최근 분기 열은 행마다 "직전 4분기"(EV/EBITDA·EPS)와 "누적"(순이익 등)이 섞여 있다(VF:3558~3560) — **누적 행은 LTM 으로 쓰지 않는다**. 일본은 회사가 분기 短信을 내도 앱 LTM 이 반기 기준이라 분기 trailing(Yahoo.com) 과는 기간 다름 |
| 추정 열 | 소스의 "0y·+1y·FY1" 같은 상대 표기를 쓰지 않고 그 추정의 **기말일**로. 9983(8월 결산)처럼 Yahoo 0y 가 이미 다음 해로 넘어간 경우가 있다(08 Q6) |
| Fwd 12M | 소스가 FY1·FY2 가중을 어떻게 했는지 문서로 확인 못 하면 "정의 미확인" |
| 시세 기반 값(시가총액·PER·PBR·EV·배당수익률) | 가격 기준일(`priceDate`)이 앱 칸의 가격 기준일과 같아야 같은 기간. 소스가 "전일 종가"(FnGuide 시세현황 일자·네이버 "전일")면 그 날짜를 증거에 남긴다. 기준일을 원문에서 못 읽으면 "기간 맞춤 실패" |
| 재작성·판본 | 인포맥스 = 원공시, Yahoo·StockAnalysis = 최신 판본(`memory/project-financial-architecture.md`), 한국 FnGuide·네이버 = 미실측 → 판본은 정의 표시(⑤-5)로 다룬다. 기간이 같으면 기간 맞춤은 통과 |
| 블룸버그 | 스냅샷 날짜보다 늦게 공시된 기간의 칸은 블룸버그 값이 실적이 아닐 수 있다(MU FY2026 예상치) → 스냅샷 날짜 < 그 기간 공시일(①)이면 "기간 맞춤 실패(스냅샷이 공시 전)" |
| 맞출 기간이 없음 | `status: "기간 맞춤 실패"` + 사유. **조용히 건너뛰지 않는다**(지금 한국 FnGuide 는 `continue` — VF:11379) |

### ⑤-3 단위·배율·통화·부호

| 소스 | 원문 표기 | 원 단위로 |
|---|---|---|
| FnGuide Invest·Finance | 억원(소수 둘째 = 백만원), EPS 원 | ×1e8 |
| FnGuide Snapshot 시가총액 | 억원 | ×1e8 |
| 네이버 finance/annual | 억원(FnGuide 값 사사오입), EPS·목표주가 원 | ×1e8 |
| Yahoo(.KS/.KQ·미국 fts) | 원·달러 정수(회사 공시값) | ×1 |
| Yahoo(.T) | 엔 | ×1 |
| StockAnalysis | 종목별 표기(백만·10만·천·1 — 전 기간 값으로 정함 `unitOfAll`, VF:3645~3650) | ×1(값이 이미 원 단위면) — 표기 단위만 `display.unit` 로 |
| 인포맥스 | 백만 달러 소수(실측 전부 천 달러 배수), EPS 달러, 시가총액 센트, 주식수 천 주 | ×1e6 후 표기 복원(VF:3511~3516) |
| 블룸버그 | 백만 소수 둘째(0.01백만) | ×1e6 |
| 株探·みんかぶ·Yahoo!ファイナンス 재무 | 백만엔 | ×1e6 |
| 배율·퍼센트 | 소스 표기 그대로(퍼센트는 퍼센트 수치로 통일 — 사전 단위 종류에 맞춤) | — |

- **표기 단위는 소스·종목의 실제 값 전체로 하나만 정한다**(값 하나로 추정하거나 여러 단위를 대입해 맞는 것을 고르지 않는다 — VF:7889~7891 원칙). 정할 수 없으면 `status: "단위 미정"`.
- **통화**: 외부 값은 원문 통화 그대로 둔다. 앱이 USD 환산값만 내는 외화 공시 기업(ASML·SPOT EUR, TSM TWD)은 ⑤ 에서 환산하지 않는다 — 환산은 ① 의 H.10 환율로 ④ 가 하거나, 원통화 비교가 불가하면 ⑥ 이 "검증불가(외부 환율 비공개)"(VF:549 `NA_FX`)로.
- **부호**: 현금흐름 유출(CapEx·배당 지급)은 소스마다 부호가 다르다(StockAnalysis 음수, 블룸버그·FnGuide 양수, DART 일부 음수 공시 — 03 §3). 사전 행의 부호 규약(예: CapEx 양수)으로 바꾸고 바꾼 사실을 `evidence` 에 남긴다.
- 주당 값: ADR 은 ADR 1주 기준(CLAUDE.md `toAdrBasis`) — 소스가 원주 기준이면 정의 다름(비율로 식이 성립하면 "다름(식)").

### ⑤-4 반올림 규칙

- 반올림 방식은 소스별로 문서에 근거가 있는 것만 쓴다:
  | 소스 | 방식 | 근거 |
  |---|---|---|
  | 일반(Yahoo·StockAnalysis·인포맥스·FnGuide 등) | 0.5 는 0 에서 먼 쪽(`roundHalfAway`) | VF:3628~3637 |
  | 블룸버그 | 짝수 반올림도 인정(`roundHalfEven`) | VF:3638~3642 (PLTR 실측) |
  | 네이버 | FnGuide 값을 사사오입 | 03 Q14 |
  | FnGuide 투자의견 상단 상자 | 버림(3.95 → 3.9) — 본문 점수는 3.95 | 03 Q14 |
- ⑤ 는 반올림 식을 **계산하지 않는다**(앱 값을 보지 않으므로). 표기 단위와 방식만 넘기고, "round(앱, 단위) = 외부" 판정은 ⑥ 이 한다.
- **미결 M7 — 표기 반올림 안에서 같을 때의 판정이 두 문서에서 다르다**:
  - 00-handoff 판정 정의 나(10-11, 가설): "같은 기간·정의·**표기 반올림 안 같음 → 일치**".
  - 오너 결정 2026-09-26(`memory/feedback-exact-match-verification.md`, VF:547~548 `NA_PRECISION`): "round(앱, 외부 단위) = 외부값으로만 설명되는 차이는 ②도 ①도 아니고 **검증불가(외부 정밀도 부족)** — 독립 근거로 인정 안 함".
  - 판정 정의는 "지난 결과로 측정 후 고정"할 가설이라, 어느 쪽인지 오너 확인 전에는 ⑤ 출력에 `display.unit`·`rounding` 만 싣고 분류를 정하지 않는다. 한국 외부 대조는 지금 둘 다 아닌 **허용 범위 비교**(`sameAt`: |차| ≤ 단위/2 — VF:3620·11448)라 09-26 "허용오차 금지"와 어긋나므로, 어느 쪽으로 정하든 바꿔야 한다.

### ⑤-5 정의 표시

- 값마다 `def.tag` 하나: **같음 / 다름(식) / 다름 / 미확인**. 기본값은 ③-3 표(실측 근거)에서 온다. 표에 없는 (소스, 지표)는 **미확인**.
- **다름(식)** 은 분해식이 줄 단위로 있을 때만(`memory/feedback-definition-diff-needs-decomposition.md` — 이름 붙이기 금지). 식 자체는 ⑤ 가 적고(`def.formula`), 식이 그 칸에서 성립하는지는 ⑥ 이 앱·① 값으로 확인한다. 성립 안 하면 ⑥ 에서 미해결(정의 다름으로 넘기지 않음).
- **다름** 은 00-handoff 나 "⑤에서 정의 다름 → 참고" — 판정 근거로 쓰지 않고 참고로만 싣는다. 예: Yahoo CapEx(유형+무형), FnGuide EPS·BPS, 다른 기관 컨센서스, 四季報 차입금.
- 회사별로 갈리는 경우(Yahoo!ファイナンス 有利子負債의 줄 누락, Yahoo.com 현금의 J-GAAP 회사)는 소스 단위 태그가 아니라 **칸 단위 태그**가 필요할 수 있다 — 회사별 구성 확인 결과가 있으면 그 칸만 "다름(식)"으로, 없으면 소스 기본 태그 그대로(외부 단독 이탈 여부는 ⑥).
- `appSource: true`(③-5)인 값은 정의가 같아도 독립 근거가 아니다 — ⑥ 이 "원천 확인"으로만 쓴다.
- 정의 태그 표는 **문서**(이 폴더, 실측 근거 링크와 함께)로 관리하고 검증기는 그 표를 데이터로 읽는다. 새 소스·지표를 넣을 때는 먼저 실측(대표 종목 숫자 대조)으로 태그를 정한다(`memory/project-financial-architecture.md` 교훈 "실측을 먼저 보이고 묻는다").

### ⑤-6 증거 기록

각 외부값에 남기는 것(재현 가능해야 함): 소스 ID·계보, URL 또는 스냅샷 파일, 수집 시각, HTTP 상태, 원문 파일 경로·sha256, 원문 안 위치(`srcKey`), 원문 값 문자열·기간 표기·표기 단위, 적용한 배율·부호 변경, 기간 맞춤 근거(`period.how`), 정의 태그와 근거 문서·줄.
- 원문 파일은 2호기 디스크에만(커밋 안 함). 결과 JSON 에는 경로·해시만. 블룸버그·FnGuide 원문은 저장소·운영 DB 에 넣지 않는다.
- 결과를 ⑧ 이 게시할 때 외부 원문 값(전재)을 화면에 싣는지는 ⑧ 설계 범위(StockAnalysis ToS "전재 금지·출처 표기").

### ⑤-7 실패 처리

| 상황 | 출력 |
|---|---|
| ③ 이 "조회 실패·차단·형식 변경" | `status: "외부 없음(조회 실패|차단|형식)"` — 원인 그대로 전달 |
| ③ 이 "소스에 값 없음" | `status: "외부 없음(소스 빈칸)"` |
| 기간 못 맞춤 | `status: "기간 맞춤 실패"` + 이유 |
| 단위·통화 못 정함 | `status: "단위 미정"` |
| 같은 칸에 같은 소스 값이 둘(다른 화면·다른 행) | 둘 다 싣고 `conflict` 표시 — 소스 자기 모순(인포맥스 연간 ≠ 분기 합처럼)은 ⑥ 의 외부 단독 이탈 재료 |
모든 실패 칸은 개수를 집계해 실행 결과에 소스별로 남긴다(조용히 사라지는 칸 0).

### ⑤-8 시험 방법

표 기반 시험(입력 원문 → 기대 출력):
1. 기간: WEN 52/53주(기말 ±7일), 3월 결산(7203 FY2026 = 2026-03-31), 9983 8월 결산과 Yahoo 0y 가 다음 해인 경우, 한국 12월 외 결산, FnGuide 최근 분기 열의 누적 행 → LTM 거부, 블룸버그 스냅샷 날짜 < 공시일.
2. 단위: FnGuide 억원 소수(2,552.50억), 네이버 사사오입, 인포맥스 천 달러·센트·천 주, 블룸버그 0.01백만, StockAnalysis 종목별 단위(MRVL 0.1백만 — VF:3644 주석 사례), 백만엔.
3. 정의 태그: 03~09 실측 결과를 그대로 재현 — Yahoo IBM CapEx → 다름, 株探 キーエンス 현금 → 같음, FnGuide EV → 다름(식) 식 문자열, 네이버 추정 → appSource.
4. 실패: 원문 없는 칸·형식 변경·종목 불일치가 각각 맞는 `status` 로.
5. ⑤ 가 ② 출력을 읽지 않는지: ② 파일 없이 ⑤ 만 돌려 같은 출력.

### ⑤-9 지금 코드와 다른 점

| # | 지금 | 설계 | 위치 |
|---|---|---|---|
| n1 | 정리와 판정이 한 함수 안 — 외부값을 앱 값과 같이 넣고(`put(item, ours, …)`) 바로 비교 | ⑤ 는 앱 값을 보지 않음, 비교는 ⑥ | VF:7912~7917·11366~11371(kr/verification) |
| n2 | 한국은 허용 범위 비교(`sameAt` 단위/2), 미국은 정확 비교 + 반올림 식 — 시장마다 규칙 다름 | 세 시장 한 규칙(M7 결정 뒤) | VF:3620·11448 vs 3627·3642 |
| n3 | 기간이 안 맞으면 조용히 건너뜀 | "기간 맞춤 실패" 기록 | VF:11379(FnGuide), VF:7974(Yahoo 미국) |
| n4 | 정의 차이가 코드 안 원인 함수·주석에 흩어짐(정의 태그 표 없음) | 정의 태그 표(문서·데이터) | VF:11383~11397, `recon-lines` 결과(VF:212~229) |
| n5 | 계보 개념 없음 — 네이버·FnGuide, 앱 원천 소스를 따로 세지 않음 | ③-5 | — |
| n6 | 부호·통화 처리가 지표별 코드에 흩어짐 | ⑤-3 한 곳 | VF F층 전반 |

---

## 미결(오너 확인) 목록

| # | 내용 | 사실(근거) | 선택지(결정 아님) |
|---|---|---|---|
| M1 | 검증 요청의 저장본 우회 | 앱 브랜치 세 개·master 에 `snap-bypass.ts` 없음, 10-09 배포에서 일부러 제외. 앱 GET 이 api_snap·ttm_snap·fin_sym 을 읽고 씀(②-3) | (가) 앱 브랜치에 우회 이식 (나) 실행 전 로컬 DB 저장본 삭제 + FIN_NO_PERSIST (다) 표시만 |
| M2 | API 에 없는 화면 값 | 개요 PER(TTM)·추정PER·배당수익률·일본 시가총액 대체는 컴포넌트 계산, `verify-row` 일본 미지원, 유니버스 화면 = DB 캐시 | 앱에 읽기 경로 추가 / 그 칸 "앱 읽기 불가"로 검증 범위 밖 표시 / 유니버스 캐시 직접 읽기(한국 K6 방식)를 세 시장으로 |
| M3 | FnGuide 원문 보관·범위 | robots `Disallow: /` + "무단 사용·DB화 시 민형사상 책임". 검증용 자동 대조는 09-24 승인. 실측은 Invest·Finance 외에 Snapshot·Consensus 도 받음 | 보관 기간(실행 중만 / 원자료 캐시 규칙) · 범위(Invest·Finance 만 / Snapshot·Consensus 포함) |
| M4 | WiseReport | 한국 현금 정의의 출처(B16)이나 접근 경로·robots 문서에 없음 | 대조 소스로 넣을지, 넣으면 robots·약관 확인 먼저 |
| M5 | 일본 株探·みんかぶ 검증 대조 사용 | 株探은 CLAUDE.md 승인 목록에 없음(08 측정에서만). みんかぶ 승인은 컨센서스 카드용 | 둘 다 검증 대조 허용 / 한쪽만 / 불허(그러면 일본 현금은 외부 없음) |
| M6 | 독립 외부 "곳" 세는 단위 | 네이버 = FnGuide 같은 값(03). Yahoo·StockAnalysis 원 공급사 미확인 | 계보 단위(③-5) / 사이트 단위 |
| M7 | 표기 반올림 안 같음의 판정 | 00-handoff 나 "일치" vs 09-26 결정 "검증불가(외부 정밀도 부족)", 한국 코드는 허용 범위 비교 | 둘 중 하나로 고정(⑥ 측정 결과와 함께) |
| M8 | 블룸버그 스냅샷 갱신 | 미국 46종목·10-07 한 번, 한국·일본 없음, 이후 공시 열은 대조 불가 | 갱신 주기·범위(오너가 내려받아 주는 자료라 오너 일) |
| M9 | 수동 확인 소스(인베스팅닷컴·MarketScreener) | 봇 차단, "브라우저 개별 확인만", 09-24 "대조군 포함" | 사람 확인 값을 증거 형식으로 넣는 입력을 만들지 / 자동 파이프라인 밖으로 둘지 |
| M10 | 추정치 칸의 외부 비교 | 추정치는 앱 원천(네이버·Yahoo)과의 대조만 같은 정의이고, 다른 기관 값은 집계가 달라 "다름". 그러면 추정치 칸은 늘 "외부 없음/원천 확인"으로 끝난다 | 그대로(원천 확인 = 통과 근거 아님) / 원천 확인을 추정치 칸의 통과 근거로 인정 |

## 다른 단계와의 경계(넘겨주는 것)

- ① → ⑤: 사업연도별 기말일·결산월·최신 공시 접수일(기간 맞춤, 재수집 주기).
- ② → ⑥: `app-cells.jsonl`(값·주석·경고·우회 여부·앱 판본).
- ⑤ → ⑥: `ext-values.jsonl`(정리된 값·표기 단위·반올림 방식·정의 태그·식·계보·appSource·상태).
- ⑥ 이 하는 것(이 문서 아님): 반올림 식 계산, 다름(식)의 식 성립 확인, 외부 단독 이탈, 공통모드 판정, 최종 판정.
- ⑧ 이 하는 것: 결과 저장·게시(운영 DB 쓰기 경로 포함), 외부 원문 값 게시 여부.
