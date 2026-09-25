# 재무 숫자 5층 구조 — 설계 (2026-09-25, 오너 결정 반영)

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
| `edgar-series.ts` fiscalYearOf·dropRoundedRetags·vintageOrder·ttmCombine·splitFactorsByYear | 1층 `read/period.ts`·`read/vintage.ts`·`read/split.ts` | `preferNewer`(최신 판본 우선)는 **폐기** — 원공시 규칙으로 대체 |
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
  htmlUrl: string | null;           // 태그 정정 판정용 본문
  gaps: number;
}
interface RawFact { concept: string; start: string | null; end: string; val: number; unit: string; dims: Record<string, string>; decimals: number | null; prov: Prov }

/** 1층 산출 — 판본이 확정된 값. */
interface ReadValue { val: number; unit: "USD" | "KRW" | "shares" | "USD/shares"; prov: Prov; why?: ReadWhy }
type ReadWhy =
  | { k: "tag-correction"; origVal: number; laterAccn: string }   // 나중 값 = 원공시 본문 → 나중 값 채택
  | { k: "restated-kept"; laterVal: number; laterAccn: string }   // 나중 값 ≠ 본문 → 원공시 유지
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
| `fin_sym` | `us:AAPL` | 종목 메타 + 열 머리글(출처 포함) + **지표 시계열** | 하이라이트·재무분석·개요·TTM·유니버스·컨센서스 실적·PPT |
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
                  "LTM":    { "d": [["...", 1], ["...", 1], ["...", -1]] },
                  "FY2021": { "k": "tc", "o": 559151000000, "a": "0000104169-22-000012" } } } }

// fin_stmt — IS 연간
{ "_id": "us:WMT:is:a", "ev": 1,
  "l": [ ["us-gaap:Revenues", "Total revenues"], ["us-gaap:CostOfRevenue", "Cost of sales"] ],
  "c": ["FY2016", "FY2017", "...", "FY2025", "LTM"],
  "s": [ [4096, 8195], ["..."] ],
  "v": [ [680985000000, 511753000000], ["..."] ],
  "x": { "FY2023": { "0": { "k": "rk", "n": 6255000000, "a": "0000106040-25-000099" } } } }

// fin_chg
{ "k": "us:WDC", "at": ISODate("..."), "ev": 2, "t": "m.rev", "c": "FY2023", "o": 6255000000, "n": 12318000000, "r": "ev" }
```

- `c`(fin_sym): `[열키, start, end, accn, form, filed, gaps]`. 파생 열(Q4D·LTM)은 accn 대신 `x.*.d` 에 구성 공시.
- `s`(fin_stmt): 열별 줄 구조 — 줄마다 정수 1개 = `사전idx * 4096 + (부모pos+1) * 2 + (w<0 ? 1 : 0)`
  (사전 4,096줄·열당 2,047줄 상한 — 초과 시 `sv` 올림). 그 공시 본표 순서 그대로.
- `v`: `s` 와 같은 순서의 값. 없는 값은 `null`.
- 예외 코드 `k`: `tc` 태그 정정(나중 값 채택, `o`=원공시 태그값), `rk` 재작성인데 원공시 유지(`n`=나중 값), `fx` 환산(`r`=환율),
  `yq` 20-F·40-F Yahoo 분기, `d` 파생 구성 `[accn, 부호]`. **예외가 아닌 칸은 출처를 따로 적지 않는다**(열 출처 = 칸 출처).
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
