# 재무 숫자 5층 구조 — 설계 (2026-09-25, 오너 결정 반영)

> 변경 이력: 2026-09-25 원공시 → 최신 판본 우선(외부 대조 근거)

> **원칙 — 숫자의 오차가 없어야 한다. 정의의 차이가 아닌 수의 차이는 심각한 오류다.**
> 모든 차이는 ① 일치 ② 정의 차이(분해식이 정확히 성립) ③ 오류 셋 중 하나로 닫는다.

범위: 미국(SEC) 먼저, 매출부터(`revenue.md`). 한국(DART)은 같은 계약에 어댑터만 추가(§10).
이 문서는 구현자가 그대로 따르는 계약서다. 바꾸려면 이 문서를 먼저 고친다.

---

## 1. 층과 모듈 경계

```
(0) 원천 어댑터   src/lib/fin/source/{us,kr}/*    외부 호출은 여기서만. 값마다 출처·완전성
(1) 판독 엔진     src/lib/fin/read/*              판본·IFRS·정정·반올림·단위·분할·기간·분기화·LTM·환율·ADR
(2) 재무제표 조립 src/lib/fin/assemble/*          한 열 = 한 공시. 그 공시 본표 구조로 IS 조립 + 항등식
(3) 지표 정의     src/lib/fin/metrics/*           조립된 줄에서 꺼냄. 회사별 예외는 overrides.ts 에만
    저장·조회     src/lib/fin/store.ts, src/lib/db/fin.ts
    배치          scripts/fin/build.ts (tsx 실행)
독립 검증         scripts/verify-financials.mjs   src/lib/fin/** import 금지(공통모드 차단)
```

의존 방향은 0 → 1 → 2 → 3 한 방향. 역방향 import 는 eslint 로 막는다(§8 S5).
**여러 지표에 걸치는 차원(판본·기간·환율·분할·IFRS)은 1층에서만** 처리한다 — 2·3층에
`fiscalYearOf`, 환율, `preferNewer` 류 코드가 나오면 설계 위반.

기존 코드 재사용(이동, 재작성 아님):

| 기존 | 새 위치 | 비고 |
|---|---|---|
| `edgar.ts` getCompanyFacts·getSubmissions, `edgar-gapfill.ts` 인스턴스 파서, `fetch-health.ts` | 0층 `source/us/sec.ts` | 로더 체인(`withX` 연쇄)은 해체 — 판독은 1층으로 |
| `edgar-foreign.ts`(IFRS 매핑·환율), `adr.ts`, `edgar-yahoo-quarters.ts` | 1층 `read/ifrs.ts`·`read/fx.ts`·`read/adr.ts`·`read/ltm-yahoo.ts` | |
| `edgar-series.ts` fiscalYearOf·dropRoundedRetags·vintageOrder·ttmCombine·splitFactorsByYear | 1층 `read/period.ts`·`read/vintage.ts`·`read/split.ts` | `preferNewer`(최신 판본 우선) 유지 — 판본 선택 규칙 한 곳으로 통일(연간·분기·누적 동일) |
| `edgar-is-structure.ts`·`edgar-revenue-dims.ts` 의 `_cal`/`.xsd` 판독 | 1층 `read/linkbase.ts` + 2층 `assemble/is.ts` | |
| `edgar-financial.ts` 순수익 합성 | 3층 `metrics/revenue.ts` 회사 유형 규칙 | |
| `edgar-series.ts` splitFactorsByYear 의 매출 태그(분할 판정 휴리스틱) | 1층 그대로 | 표시 숫자가 아니라 판정 보조 — 매출 지표 규칙 적용 대상 아님(문서화된 예외) |

## 2. 데이터 계약 (`src/lib/fin/types.ts`)

```ts
type Market = "us" | "kr";
type FormType = "10-K" | "10-K/A" | "10-Q" | "10-Q/A" | "20-F" | "20-F/A" | "40-F" | "40-F/A"
  | "8-K" | "6-K" | "YAHOO-Q" | "DART-11011" | "DART-11012" | "DART-11013" | "DART-11014";
type SourceId = "sec-cf" | "sec-inst" | "sec-htm" | "yahoo" | "infomax" | "ecos" | "dart";

/** 0층 — 모든 값에 붙는 출처. */
interface Prov { accn: string | null; form: FormType; filed: string | null; source: SourceId; dims?: Record<string, string> }

/** 완전성 비트마스크. 0 = 완전. 실패를 다른 원천으로 조용히 대체하지 않고 이 비트로 남긴다. */
const enum Gap {
  CF_FETCH = 1, INSTANCE = 2, LINKBASE = 4, HTML = 8, YAHOO = 16, FX = 32,
  IDENTITY = 64,       // 조립 항등식 불성립
  BASIS_SHIFT = 128,   // 파생 열(Q4·LTM) 구성요소의 기준이 다름(중단사업 재분류 등)
  STALE = 256,         // 최신 정기공시가 SEC 목록에 있는데 판독 못함
}

/** 0층 산출 — 공시 하나의 원자료 (DB 저장 안 함). */
interface RawFiling {
  accn: string; form: FormType; filed: string; fyEnd: string; periodEnd: string;
  facts: RawFact[];                 // 인스턴스(없으면 companyfacts 에서 그 accn 분) — 차원 포함
  pre: PresentationTree | null;     // _pre 또는 .xsd 내장
  cal: CalculationTree | null;      // _cal 또는 .xsd 내장
  labels: Map<string, string>;
  gaps: number;
}
interface RawFact { concept: string; start: string | null; end: string; val: number; unit: string; dims: Record<string, string>; decimals: number | null; prov: Prov }

/** 1층 산출 — 판본이 확정된 값. */
interface ReadValue { val: number; unit: "USD" | "KRW" | "shares" | "USD/shares"; prov: Prov; why?: ReadWhy }
type ReadWhy =
  | { k: "fx"; cur: string; rate: number; basis: "avg" | "spot" }
  | { k: "yahoo-q"; through: string }
  | { k: "derived"; parts: { accn: string; form: FormType; sign: 1 | -1 }[] };  // Q4·LTM

/** 2층 — 한 열 = 한 공시(또는 명시된 파생). */
type ColKind = "FY" | "Q" | "Q4D" | "LTM";
interface Column {
  key: string;            // "FY2025" | "2026Q2" | "2025Q4" | "LTM"
  kind: ColKind; fy: number; fq: 0 | 1 | 2 | 3 | 4;
  start: string; end: string;
  src: Prov | Prov[];     // FY·Q = 공시 1건, Q4D·LTM = 구성 공시들
  gaps: number;
}
interface StmtLine {
  id: string;             // 개념 id("us-gaap:Revenues", "xom:...") 또는 합성 id("syn:...")
  label: string;          // 그 공시 _pre 라벨(원본 표현 그대로)
  parent: number | null;  // 같은 열 줄 목록 안의 부모 위치(_cal)
  w: 1 | -1 | 0;          // 부모 계산 가중치(0 = 계산 관계 없음)
  role: LineRole | null;  // 구조로 붙인 역할(아래). 어느 줄을 지표로 쓸지는 3층이 정함
  v: number | null;
  why?: ReadWhy;          // 예외 칸만
}
type LineRole = "revenue" | "revenue.total" | "revenue.net" | "revenue.nonop" | "cogs" | "gross" | "opinc" | "pretax" | "tax" | "ni" | "ni.parent";
interface AssembledIs { col: Column; lines: StmtLine[]; identity: { ok: boolean; fails: string[] } }

/** 3층 — 지표 값. 파생은 같은 기준(같은 열 키·같은 end)일 때만. */
interface MetricValue { v: number | null; col: string; end: string; line: string | null; rule: string; gaps: number; why?: ReadWhy }
interface MetricSeries { metric: "revenue"; unit: "USD" | "KRW"; values: Record<string, MetricValue> }
interface CompanyProfile {
  market: Market; symbol: string; cik: string; sic: number | null;
  type: "general" | "bank" | "broker" | "insurer" | "captive" | "reit";
  filer: "domestic" | "20-F" | "40-F"; adrRatio: number; reportingCurrency: string;
}
```

- 3층 시그니처: `revenue(cols: AssembledIs[], co: CompanyProfile): MetricSeries`.
- 회사 유형(`type`)은 1층 `read/profile.ts` 한 곳에서 판정(SIC + 공시 구조) — 지금처럼 `isFinancialCompany`·`financialSector`·SIC 범위가 모듈마다 따로 있지 않게.
- 회사별 예외는 `metrics/overrides.ts` 한 곳: `{ symbol, metric, rule, evidence, since }`. `evidence`(공시 accn·숫자로 된 근거) 없는 항목은 금지.
- 공개 API(`src/lib/fin/index.ts`): `assemble(market, symbol, {persist})`, `getFinSym(market, symbol)`, `getFinStmt(market, symbol, stmt, period)`, `metricAt(sym, metric, colKey)`. 그 밖의 내부 모듈 직접 import 금지.

## 3. DB 스키마 — 유니버스 종목만 저장 (압축형)

**저장 대상 = 유니버스 종목(현재 미국 47 + 한국 약 30)만**(오너 정정 2026-09-25). 새로 담기면 그때 조립·저장,
전 계정에서 빠지면 삭제. SEC·DART 원자료(companyfacts·인스턴스·linkbase·HTML)는 **저장하지 않는다** — 조립 결과만.
유니버스 밖 종목(종목분석은 공개라 아무 종목이나 조회 가능)과 검증 대상(S&P 500 등)은 **비저장 조립 모드**(§5.3).

### 3.1 컬렉션

| 컬렉션 | 키(`_id`) | 문서 | 읽는 곳 |
|---|---|---|---|
| `fin_sym` | `us:AAPL` | 종목 메타 + 열 머리글(출처 포함) + **지표 시계열** | 하이라이트·재무분석·개요·TTM·유니버스·컨센서스 실적 |
| `fin_stmt` | `us:AAPL:is:a`, `us:AAPL:is:q` (지표 확장 시 `bs`·`cf`) | 재무제표 × 주기의 줄 사전 + 열별 구조·값 | 손익계산서·총괄 화면 |
| `fin_chg` | 자동 ObjectId | 바뀐 칸 1건 = 문서 1건(감사 추적) | 관리자 화면·회귀 조사 |

인덱스: `fin_sym`·`fin_stmt` 는 `_id` 만. `fin_chg` 는 `{k:1, at:-1}` + TTL(`at`, 180일).
이번 단계(매출)는 `fin_stmt` 의 `is` 만 만든다 — BS·CF 는 해당 지표를 닫을 때 추가(오너 결정).

### 3.2 문서 형태 (BSON 필드명 짧게)

```jsonc
// fin_sym — 열 출처는 여기 1회만(fin_stmt 는 열 키로 참조)
{ "_id": "us:WMT", "ev": 1, "sv": 1, "at": ISODate("..."), "la": "0000104169-26-000123",
  "p": { "t": "general", "fl": "domestic", "sic": 5331, "cur": "USD", "adr": 1 },
  "g": 0,
  "c": [ ["FY2025", "2024-02-01", "2025-01-31", "0000104169-25-000021", "10-K", "2025-03-14", 0],
         ["2026Q2", "2025-05-01", "2025-07-31", "...", "10-Q", "...", 0],
         ["2025Q4", "2024-11-01", "2025-01-31", null, "Q4D", null, 0],
         ["LTM",    "2025-08-01", "2026-07-31", null, "LTM", null, 0] ],
  "m": { "rev": [680985000000, 177402000000, 180554000000, 735840000000] },
  "x": { "rev": { "2025Q4": { "d": [["0000104169-25-000021", 1], ["0000104169-24-000150", -1]] },
                  "LTM":    { "d": [["...", 1], ["...", 1], ["...", -1]] } } } }

// fin_stmt — IS 연간
{ "_id": "us:WMT:is:a", "ev": 1,
  "l": [ ["us-gaap:Revenues", "Total revenues"], ["us-gaap:CostOfRevenue", "Cost of sales"] ],
  "c": ["FY2016", "FY2017", "...", "FY2025", "LTM"],
  "s": [ [4096, 8195], ["..."] ],
  "v": [ [680985000000, 511753000000], ["..."] ] }

// fin_chg
{ "k": "us:WDC", "at": ISODate("..."), "ev": 2, "t": "m.rev", "c": "FY2023", "o": 6255000000, "n": 12318000000, "r": "ev" }
```

- `c`(fin_sym): `[열키, start, end, accn, form, filed, gaps]`. 파생 열(Q4D·LTM)은 accn 대신 `x.*.d` 에 구성 공시.
- `s`(fin_stmt): 열별 줄 구조 — 줄마다 정수 1개 = `사전idx * 4096 + (부모pos+1) * 2 + (w<0 ? 1 : 0)`
  (사전 4,096줄·열당 2,047줄 상한 — 초과 시 `sv` 올림). 그 공시 본표 순서 그대로.
- `v`: `s` 와 같은 순서의 값. 없는 값은 `null`.
- `i`(fin_sym, 선택): 조립 항등식 불성립 열 `[열키, 매출 경로 불성립[], 매출 외 줄 불성립[], 매출 경로 판정 불완전[]]` — 매출
  경로 완전 판정 불성립이면 그 열 `m.rev` 는 null, 판정 불완전이면 값은 두고 "항등식 미검증"(`revenue.md` §6.1, 4번째 칸은
  엔진판 4부터). `ck`(선택): 배치가 "새 정기공시 없음"을 마지막으로 확인한 시각(§5.1). 엔진판 3(2026-09-25)부터.
- 예외 코드 `k`: `fx` 환산(`r`=환율), `yq` 20-F·40-F Yahoo 분기, `d` 파생 구성 `[accn, 부호]`.
  **예외가 아닌 칸은 출처를 따로 적지 않는다**(열 출처 = 칸 출처) — 반올림 재태깅 제거
  (`dropRoundedRetags`)로 버려진 값은 애초에 후보에서 빠지므로 별도 예외 코드가 없다. (태그 정정
  판정용 `tc`·`rk` 코드는 2026-09-25 최신 판본 우선 회귀로 삭제 — §2 변경 이력 참고.)
- **이전 판본은 복사하지 않는다** — 재조립 결과를 옛 문서와 칸 단위로 비교해 바뀐 칸만 `fin_chg` 에 쓰고 본문서는 교체.
- 가격 의존 값(시가총액·PSR·EV·배수)은 **저장하지 않는다** — 조회 시 시세와 결합(§6).

### 3.3 저장 예산 (Atlas M0 512MB, 현 사용 약 23MB = 데이터 19MB + 인덱스 3.4MB)

종목당 크기 — 최종형(IS·CF·BS 원본 줄 + 지표, 합계 약 210줄), 연간 10 + 분기 20 + LTM 1 = 31열:

| 부분 | 계산 | 크기 |
|---|---|---|
| 줄 사전(3표 × 2주기 합집합) | 약 250줄 × (개념 35B + 라벨 45B + BSON 오버헤드 20B) | 25KB |
| 구조 `s` | 31열 × 평균 150줄 × 정수 1개(BSON 배열 원소 약 9B) | 42KB |
| 값 `v` | 31열 × 150줄 × 약 12.5B(double 원소) | 58KB |
| `fin_sym` | 열 머리글 31 × 90B + 지표 30개 × 31열 × 12.5B + 예외 약 1KB | 15KB |
| **합계** | | **약 140KB/종목** |

- 유니버스 77종목(미국 47 + 한국 30) × 140KB ≈ **10.8MB**. 매출 단계(IS 만)는 그 1/3 수준(약 4MB).
- `fin_chg`: 새 정기공시 1건 ≈ 150칸 × 110B ≈ 16KB → 77종목 × 연 4건 ≈ 5MB/년. 엔진판 올림 1회 ≈ 77 × 30KB ≈ 2.3MB.
  TTL 180일 → 상시 **약 3~5MB**.
- 합계 **약 15MB, 판본 변경분 포함 20MB 안팎**(인덱스 포함 — `_id` 인덱스는 종목당 수백 바이트). 기존 23MB 와 합쳐 약 45MB, M0 한도의 9%.
  유니버스가 200종목으로 늘어도 약 40MB.
- 한도 근접(예: 400MB) 시 순서: ① `fin_chg` TTL 90일 ② 분기 열 20 → 12 ③ 연간 10 → 7 ④ M2 이상 유료 등급 — ④는 오너 결정.
- **가정**: M0 한도를 BSON 데이터 크기(비압축) + 인덱스로 보고 계산했다(WiredTiger 압축 이득은 여유분으로 둠). 첫 적재 후 `db.stats()` 로 실측해 이 표를 갱신한다.

## 4. 조회 API — 소비처 통합 원칙

모든 소비처(하이라이트·재무분석·손익계산서·컨센서스·개요·유니버스 등)는 §2 의 공개 API
(`assemble`·`getFinSym`·`getFinStmt`·`metricAt`)만 호출한다. 소비처가 SEC/DART 원자료를 다시 읽거나
지표를 스스로 계산하면 안 된다 — 지금 구조의 근본 문제(화면마다 다른 함수가 같은 계산을 따로 해
갈라짐 — EBITDA·PBR·EV 가 하이라이트·재무분석·컨센서스마다 다르던 문제)가 그대로 재발한다.
지표별 소비처 목록·검증 규칙은 각 지표 문서(`revenue.md` 등)에 둔다. 내부 모듈(`read/*`·`assemble/*`·
`metrics/*` 안의 개별 파일) 직접 import 는 §8 S1 로 막는다.

## 5. 실행 모드

같은 0→3층 파이프라인을 세 방식으로 돌린다. 차이는 "저장하는가"와 "누가 트리거하는가"뿐이다.

### 5.1 배치 저장 모드
- 대상: 유니버스 종목만(§3).
- 트리거: GitHub Actions `.github/workflows/fin-build.yml`(하루 1회 06:10 KST + 수동) → 배포 라우트
  `POST /api/cron/fin-build`(CRON_SECRET) → `refreshStored()`(src/lib/fin/index.ts). 유니버스(전 계정 합집합) 중
  **저장본 없음 → 엔진판(`ENGINE_VERSION`) 다름 → 저장 후 새 정기공시(제출 목록의 최신 10-K/10-Q accn ≠ `la`)** 인 종목만,
  호출당 3종목·함수 마감 60초 전 이후 새 조립 금지. 새 공시가 없으면 `ck`(확인 시각)만 남기고 다음 호출은 오래 확인 안 한
  종목부터 본다. 워크플로는 응답 `pending` 이 0 이 될 때까지 반복 호출(남았는데 진행 0 이면 실패). 제출 목록 조회 실패 종목은
  `skipped` 로 응답에 싣고 확인 시각을 남기지 않는다. 저장본 `la` 가 null 인 종목은 7일에 한 번만 다시 조립(예전엔 배치마다).
  로컬 수동: `scripts/fin/build.ts`(지정 종목 강제 재적재).
- **배포 전 확인(미배포)**: 라우트 `maxDuration = 300` 초가 Vercel 요금제 함수 시간 한도 안인지 먼저 확인할 것(요금제에 따라
  더 짧다 — 한도가 짧으면 `maxDuration`·호출당 종목 수 `n` 을 함께 낮춘다).
- 조회(§5.2)는 엔진판이 다른 저장본을 쓰지 않는다(`loadFinSym`) — 규칙이 바뀐 뒤 배치가 다시 적재할 때까지 비저장 조립.
- `assemble(market, symbol, {persist:true})` → 0~3층 실행 → `fin_sym`/`fin_stmt` 갱신, 바뀐 칸만
  `fin_chg` 에 기록(§3.2).
- 원자료 조회 실패 등으로 일부만 판독됐으면 기존 문서를 유지하고 `g`(gaps) 비트만 올린다 — 부분
  실패로 전체 문서를 비우지 않는다(기존 `fetchWarnings` 처리 원칙과 동일).

### 5.2 조회 모드 (캐시 히트)
- 유니버스 종목의 화면 요청은 `fin_sym`/`fin_stmt` 를 그대로 읽는다(§4 API) — 요청 시점에 0~3층을
  다시 돌리지 않는다.
- 가격 결합(§6)만 요청 시점에 얹는다.

### 5.3 비저장 조립 모드
- 대상: ① 종목분석은 로그인 없이 공개라(CLAUDE.md) 유니버스 밖 종목도 조회할 수 있는데 그 경우,
  ② 검증 스크립트가 대상으로 삼는 S&P 500 등 비유니버스 종목.
- `assemble(market, symbol, {persist:false})` → 0~3층을 그 요청 안에서 실행해 결과만 반환하고
  `fin_sym`/`fin_stmt`/`fin_chg` 어디에도 쓰지 않는다.
- Next.js 라우트 캐시 정책(화면별 기존 규칙 그대로)만 적용 — DB 영속화는 없다.
- 검증 스크립트(`scripts/verify-financials.mjs`)는 이 모드의 결과를 **기대치 계산용으로만** 쓰고
  그 결과 자체를 저장하지 않는다 — §1 표의 "공통모드 차단"과 같은 원칙(검증기가 배치 결과를
  재사용하면 같은 버그를 같이 통과시킬 수 있다).

## 6. 가격 결합 (파생 — 저장하지 않음)

시가총액·PSR·EV·PBR·배당수익률처럼 "지표 × 가격"으로 나오는 값은 3층 지표(`MetricValue`, 통화
단위)와 그 시점 시세(`getEodQuote`·KRX 종가)를 요청 시점에 결합해서만 낸다(`src/lib/fin/priced.ts`).
DB 에 들어가지 않으므로 §1 의 0~3층 번호를 매기지 않는다. 이유는 기존 `edgar-ev.ts`/`dart-ev.ts` 와
같다 — 가격은 하루에도 여러 번 바뀌는데 지표는 공시 주기로만 바뀌므로, 같이 저장하면 둘 중 하나는
항상 오래된 값이 된다. 연도 열(과거 시가총액)은 그 해 결산일 종가로 고정(기존 규칙 그대로), LTM·
현재가 열만 최신 시세를 쓴다.

## 7. 롤아웃 순서

한 번에 다 바꾸지 않는다. 지표 하나를 0→3층으로 끝까지 세워 소비처를 전환하고, 검증에서 실패 0 을
확인한 뒤에만 다음 지표로 넘어간다.

1. **매출**(`revenue.md`) — `fin_stmt.is` 만 만든다. 기존 `edgar-*.ts` 매출 계산은 소비처별로
   하나씩 새 API 로 교체한다(빅뱅 전환 금지 — 화면 단위로 스위치, 전환 안 된 화면은 옛 계산을
   그대로 씀).
2. 매출의 확인된 소비처가 전부 전환되고 `verify:financials`(§8) 가 매출 항목에서 실패 0 을 내면,
   다음 지표로 확장한다. 순서(오너 결정 2026-09-25): **손익계산서 항목 순**(매출 → 매출원가·
   매출총이익 → 판관비·R&D → 일회성비용 → 영업이익 → 이자·영업외·지분법 → 세전이익 → 법인세 →
   순이익 → EPS) → **현금흐름표**(영업CF, 감가상각비·EBITDA, CapEx, FCF, 배당·자사주) →
   **재무상태표**(현금·단기투자, 차입금·리스, 자본, 자산, 주식수) → **파생**(시가총액·EV·멀티플).
3. `fin_stmt` 에 `bs`·`cf` 는 그 지표를 조립하는 데 필요해질 때 추가한다(예: EV 지표 착수 시 `bs`
   추가) — 미리 만들지 않는다(§3.1).
4. 한국(DART) 어댑터(§10)는 미국 쪽 지표 롤아웃을 어느 정도 마친 뒤 시작 — 같은 계약에 원천만
   바꿔 끼우는 작업이라 순서를 늦춰도 손해가 없다.
5. 각 단계에서 옛 모듈(`edgar-*.ts`)은 그 지표의 마지막 소비처가 전환될 때까지 남겨둔다 — 중간
   상태에서 두 계산이 동시에 존재하는 게 정상이다.

## 8. 강제 장치

| 코드 | 규칙 | 수단 |
|---|---|---|
| S1 | 소비처는 `src/lib/fin/index.ts` 공개 API만 import. `read/*`·`assemble/*`·`metrics/*` 내부 파일 직접 import 금지 | eslint `no-restricted-imports`(소비처 디렉터리 대상) |
| S2 | 회사별 예외는 `metrics/overrides.ts` 한 곳, `evidence`(공시 accn·숫자) 없는 항목 금지 | 코드리뷰 + 런타임에서 evidence 없는 override 로드 시 throw |
| S3 | `scripts/verify-financials.mjs` 는 `src/lib/fin/**` import 금지(공통모드 차단, §1) | eslint `no-restricted-imports`(스크립트 대상) |
| S4 | 2·3층에서 판본 선택 코드 재등장 금지(`fiscalYearOf`·`preferNewer` 등) — 환율·분할·기간 계산 로직(환율 리터럴 등)도 동일하게 금지 | eslint `no-restricted-syntax`(디렉터리 스코프, 기존 `edgar-ev.ts` 규칙과 같은 방식) |
| S5 | 계층 역방향 import 금지 — 0→1→2→3 단방향만 | eslint `import/no-restricted-paths`(zone 설정) |

빌드 전 `npm run lint`·`npm run typecheck`(레포 공통 규칙, CLAUDE.md)에서 S1~S5 가 같이 걸린다.
`scripts/verify-financials.mjs`(§5.3 이 결과를 소비)를 고칠 때는 CLAUDE.md 의 "검증 도구 수정 후
독립 재감사" 원칙이 이 설계를 구현한 뒤에도 그대로 적용된다.

## 9. 한계 · 미결

- 저장 예산(§3.3)은 실제 조립 전 추정치다 — 매출 단계 적재 후 `db.stats()` 로 재검증한다.
- 회사 유형 판정(`read/profile.ts`)은 SIC + 공시 구조 휴리스틱이라 완전하지 않다(기존
  `isFinancialCompany` 류와 같은 한계 — 새 회사가 늘면 예외가 늘 수 있음).
- 20-F·40-F 제출사의 LTM 은 여전히 Yahoo 분기에 의존(`read/ltm-yahoo.ts`) — SEC 자체 분기 공시가
  없는 구조적 제약이라 이 설계로도 해소되지 않는다.
- IFRS 매핑(`read/ifrs.ts`)은 종목이 늘 때마다 수동 확장이 필요하다(현재 TSM·SPOT 뿐).
- **다음 지표 주의 — 옛 모듈 비매출 행의 Q4 판본 규칙 불일치(감사 2026-09-25, 고치지 않고 기록)**: 손익계산서 분기 화면
  (`lib/markets/us/edgar-income.ts` `quarterValue`)의 매출 외 행(매출원가·영업이익 등)은 Q4 = "가장 늦게 제출된 연간 값" −
  "가장 늦게 제출된 9개월 값"을 **따로** 고른다 — fin 1층(Q4D = 사업연도 최신 판본 − 9개월 최신 판본, 구성 공시가 개념을
  안 가지면 BASIS_SHIFT)과 달리 판본 기준이 섞여도(재작성된 10-K − 원공시 10-Q) 값을 만든다. 매출 행은 fin 값이라 같은
  열에서 매출과 다른 행의 기준이 다를 수 있다. 해당 지표를 fin 으로 옮길 때(§7 순서) 함께 없어진다.
- 조립 항등식 판정 불완전(값 없는 항·표시 줄에 없는 항·둘 이상 식의 항·식 밖 줄·파생 열 구성 공시의 식 구성 다름)은 매출을
  비우지 않고 "항등식 미검증"으로 표시한다(`revenue.md` §6.1) — 대신 검증기가 그 열을 SEC 본표와 직접 대조한다. 다음 지표를
  세울 때 그 줄의 값이 필요한 열이면 판독 원천을 늘려 닫는다(특히 ③ 차원 값 줄 — TSLA 2016~2018 자동차 매출).
- `metrics/overrides.ts` 가 지표 확장과 함께 계속 늘어난다 — 일정 규모를 넘으면 회사별이 아니라
  유형별 규칙(`read/profile.ts`)으로 승격할지 재검토한다.

## 10. 한국(DART) 어댑터 (§7 순서상 미국 롤아웃 이후 착수)

같은 4층 계약에 원천만 바꿔 끼운다 — 타입(`types.ts`)·2·3층 인터페이스는 그대로, 0·1층만 한국 전용.

- **0층** `source/kr/dart.ts`: 기존 `dart-facts.ts`(연도별 최신 보고서만 선택하는 로직 포함)를
  이동. `Prov.source = "dart"`, `FormType` 은 이미 `DART-11011~11014`(사업·반기·1·3분기보고서)로
  §2 에 정의돼 있다.
- **1층**: 판본 규칙 자체가 다르다 — DART 는 "그 해 가장 최신 보고서의 값만" 쓰고(재작성 판정 없음,
  `dropRoundedRetags` 류가 적용되지 않음). 분기화도 다르다 — 반기만 공시되고 4분기 보고서가 없어
  미국식 `Q4D`(연간 − 3분기 누적) 파생이 안 되므로 `ColKind` 는 `FY`·`Q`(반기)·`LTM` 만 쓴다.
  LTM 은 기존 `krLtmBalance()` 로직(연말 + 최신 반기 − 전년 동기 반기)을 `read/period.ts` 로 이식.
- **2층**: `fnlttSinglAcntAll` 계정과목명을 원본 그대로 줄로 조립한다(CLAUDE.md "재무제표 표시
  규칙" — 재가공 금지 원칙과 일치). 항등식 검사는 미국의 `_cal.xml` 계산관계 트리가 없어 한국
  표준계정코드 합계 규칙으로 대체한다.
- **3층**: 매출 정의는 손익계산서 매출 줄 그대로(은행·보험 등 유형별 예외를 한국 매출 지표에
  적용할지는 그때 별도 결정 — 이 문서는 일반 기업만 범위로 한다).
- **DB**: `fin_sym`/`fin_stmt` 의 `_id` 접두어를 `kr:005930` 식으로 둬 시장을 구분한다. 스키마(§3.2)
  는 공용.
- **검증**: SEC 대응 A층(원자료 직접 대조)이 DART 는 아직 없다(`revenue.md` §7 과 동일한 제약) —
  B~D층(화면 간·항등식·기대치)과 F층(FnGuide 등 외부 대조)만 우선 적용하고, A층은 별도 착수가
  필요하다.
