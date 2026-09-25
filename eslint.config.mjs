import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // 검증 체계 1층(오너 지시 2026-09-23 — "숫자는 화면 간 불일치가 완벽하게 없어야"):
  // 미국 멀티플 계산 모듈은 차입금·리스·감가상각비·장기투자 태그를 직접 고르지 말고
  // lib/markets/us/edgar-ev.ts(단일 기준)를 거쳐야 한다. 화면마다 태그 목록을 따로
  // 두던 것이 EV/EBITDA 불일치의 원인이었다(WMT·MCD·VZ 등). 표시용 재무제표 모듈
  // (edgar.ts·edgar-balance.ts·edgar-cashflow.ts)은 원본 계정을 보여주는 곳이라 제외.
  {
    files: [
      "src/lib/markets/us/edgar-highlights.ts",
      "src/lib/markets/us/edgar-analysis.ts",
      "src/lib/markets/multiples.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "Literal[value=/^(LongTermDebt\\w*|DebtCurrent|ShortTermBorrowings|OtherShortTermBorrowings|CommercialPaper|DebtLongtermAndShorttermCombinedAmount|DebtInstrumentCarryingAmount|NotesPayable|LoansPayable|OperatingLeaseLiability\\w*|FinanceLeaseLiability\\w*|DepreciationDepletionAndAmortization|DepreciationAmortizationAndAccretionNet|DepreciationAndAmortization|DepreciationAmortizationAndOther|AmortizationOfIntangibleAssets|LongTermInvestments|MarketableSecuritiesNoncurrent|MinorityInterest\\w*|PreferredStockValue\\w*)$/]",
          message:
            "EV·차입금·감가상각비 계산 태그는 lib/markets/us/edgar-ev.ts 에서만 고른다(검증 체계 1층). 이 모듈에서 직접 쓰지 말 것.",
        },
      ],
    },
  },
  // 재무 5층 구조 강제 장치(docs/metrics/architecture.md §8).
  // S1 — 소비처는 src/lib/fin/index.ts 공개 API 만. 내부 파일(read·assemble·metrics·source·store·types) 직접 import 금지
  {
    files: ["src/**/*.{ts,tsx}", "scripts/**/*.{ts,mjs}"],
    ignores: ["src/lib/fin/**", "scripts/fin/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(^@/lib/fin/|/fin/)(read|assemble|metrics|source|store|types)(/|$)",
              message: "재무 5층 구조 내부 모듈 — src/lib/fin/index.ts 공개 API(assemble·getFinSym·getFinStmt·metricAt)만 쓴다(architecture.md §8 S1).",
            },
          ],
        },
      ],
    },
  },
  // S3 — 독립 검증기는 새 경로를 import 하지 않는다(공통모드 차단)
  {
    files: ["scripts/verify-financials.mjs"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ regex: "lib/fin(/|$)", message: "검증기는 src/lib/fin 을 import 하지 않는다(architecture.md §1·§8 S3 — 공통모드 차단)." }] },
      ],
    },
  },
  // S4 — 2·3층에서 판본·기간·환율 규칙 재등장 금지(1층 read/* 한 곳)
  {
    files: ["src/lib/fin/assemble/**/*.ts", "src/lib/fin/metrics/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name=/^(fiscalYearOf|preferNewer|newer|latest|dropRoundedRetags|shiftYear|addDays|durKind|buildCalendar|avgRate|rateAt|makeFx|yahooLtmOf|isStaleAnnual)$/]",
          message: "판본·기간·환율 규칙은 1층(src/lib/fin/read)에서만 — 2·3층에서 다시 계산하지 말 것(architecture.md §8 S4).",
        },
        {
          selector: "ImportDeclaration[source.value=/read\\/(period|vintage|fx|ltm-yahoo)$/]",
          message: "판본·기간·환율 모듈은 1층 안에서만 쓴다(architecture.md §8 S4).",
        },
      ],
    },
  },
  // S5 — 층 역방향 import 금지(0 source → 1 read → 2 assemble → 3 metrics)
  {
    files: ["src/lib/fin/**/*.ts"],
    rules: {
      "import/no-restricted-paths": [
        "error",
        {
          zones: [
            { target: "./src/lib/fin/source", from: ["./src/lib/fin/read", "./src/lib/fin/assemble", "./src/lib/fin/metrics", "./src/lib/fin/store.ts", "./src/lib/fin/index.ts"], message: "0층(source)은 위층을 import 하지 않는다(S5)." },
            { target: "./src/lib/fin/read", from: ["./src/lib/fin/assemble", "./src/lib/fin/metrics", "./src/lib/fin/store.ts", "./src/lib/fin/index.ts"], message: "1층(read)은 2·3층을 import 하지 않는다(S5)." },
            { target: "./src/lib/fin/assemble", from: ["./src/lib/fin/metrics", "./src/lib/fin/store.ts", "./src/lib/fin/index.ts"], message: "2층(assemble)은 3층을 import 하지 않는다(S5)." },
            { target: "./src/lib/fin/metrics", from: ["./src/lib/fin/store.ts", "./src/lib/fin/index.ts"], message: "3층(metrics)은 저장·공개 API 를 import 하지 않는다(S5)." },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
