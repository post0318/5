import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// 매출 태그 직접 사용 금지(docs/metrics/architecture.md §4·§8, revenue.md §3) — 매출은 재무 5층 구조(src/lib/fin)의 매출 지표
// (lib/markets/us/fin-revenue.ts)에서만 받는다. 화면 모듈이 매출 태그를 다시 고르면 화면마다 매출이 갈린다(revenue.md D1·D2).
const REVENUE_TAG = "^(us-gaap:)?(Revenues|RevenueFromContractWithCustomer(Excluding|Including)AssessedTax|RevenuesNetOfInterestExpense|SalesRevenueNet|OperatingRevenueExcludingNonoperatingDerived|FinNetRevenueDerived)$";
const REVENUE_TAG_RULES = [
  { selector: `Literal[value=/${REVENUE_TAG}/]`, message: "매출 태그 직접 사용 금지 — 매출은 lib/markets/us/fin-revenue.ts(재무 5층 구조 매출 지표)에서만 받는다(architecture.md §8)." },
  { selector: `MemberExpression > Identifier.property[name=/${REVENUE_TAG}/]`, message: "매출 태그 직접 사용 금지 — 매출은 lib/markets/us/fin-revenue.ts(재무 5층 구조 매출 지표)에서만 받는다(architecture.md §8)." },
];

// 매출원가·매출총이익 태그 직접 사용 금지(docs/metrics/cogs.md §2) — 두 값은 재무 5층 구조(src/lib/fin)의 cogs·gp 지표(fin-revenue.ts 열의
// cogs·gp)에서만 받는다. 태그 우선순위로 고르면 CAT 주석 조각·MCD 10-Q 가맹점 임차비용이 매출원가로 새었다(cogs.md §5).
const COGS_TAG = "^((us-gaap|ifrs-full):)?(CostOfRevenue|CostOfGoodsAndServicesSold|CostOfGoodsSold|CostOfGoodsAndServiceExcludingDepreciationDepletionAndAmortization|CostOfSales|GrossProfit)$";
const COGS_TAG_RULES = [
  { selector: `Literal[value=/${COGS_TAG}/]`, message: "매출원가·매출총이익 태그 직접 사용 금지 — lib/markets/us/fin-revenue.ts 열의 cogs·gp(재무 5층 구조 지표)에서만 받는다(architecture.md §8, cogs.md §2)." },
  { selector: `MemberExpression > Identifier.property[name=/${COGS_TAG}/]`, message: "매출원가·매출총이익 태그 직접 사용 금지 — lib/markets/us/fin-revenue.ts 열의 cogs·gp(재무 5층 구조 지표)에서만 받는다(architecture.md §8, cogs.md §2)." },
];

// 판관비·연구개발비 태그 직접 사용 금지(docs/metrics/sga.md §3) — 두 값은 재무 5층 구조(src/lib/fin)의 sga·rnd 지표(fin-revenue.ts 열의
// sga·rnd)에서만 받는다. 태그 목록(SG&A → G&A 순)으로 고르면 판매·마케팅 줄이 여러 줄인 회사(AMAT·GOOG·META 등 13곳)에서 일반관리비만
// 판관비로 잡혔다(sga.md §5).
const SGA_TAG = "^((us-gaap|ifrs-full):)?(SellingGeneralAndAdministrativeExpense|GeneralAndAdministrativeExpense|SellingAndMarketingExpense|SalesAndMarketingExpense|MarketingExpense|OtherSellingGeneralAndAdministrativeExpense|ResearchAndDevelopmentExpense|ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost)$";
const SGA_TAG_RULES = [
  { selector: `Literal[value=/${SGA_TAG}/]`, message: "판관비·연구개발비 태그 직접 사용 금지 — lib/markets/us/fin-revenue.ts 열의 sga·rnd(재무 5층 구조 지표)에서만 받는다(sga.md §3)." },
  { selector: `MemberExpression > Identifier.property[name=/${SGA_TAG}/]`, message: "판관비·연구개발비 태그 직접 사용 금지 — lib/markets/us/fin-revenue.ts 열의 sga·rnd(재무 5층 구조 지표)에서만 받는다(sga.md §3)." },
];

// 리서치 수집기 공통 lib 호출 강제(오너 지시 2026-09-25 — "?? scripts/lib
// 강제고 호출도 강제다"). no-restricted-syntax는 "쓰지 마라"만 표현할 수
// 있어서, "최소 1번은 써야 한다"는 별도 커스텀 규칙으로 만들었다 — import만
// 하고 안 부르는 것도 위반으로 잡는다(import한 함수를 실제 CallExpression
// 으로 호출하는지 AST에서 직접 확인).
const localRules = {
  rules: {
    "require-common-lib-call": {
      meta: {
        type: "problem",
        docs: {
          description: "리서치 수집기는 exclude-filters.mjs 의 공통 판정 함수를 최소 1회 호출해야 한다",
        },
        messages: {
          missing:
            '이 수집기는 scripts/lib/exclude-filters.mjs 의 공통 판정 함수(isCommonExcludedContent 등)를 최소 1번 호출해야 한다(오너 지시 2026-09-25 — "scripts/lib 강제고 호출도 강제다"). import만 하고 안 쓰는 것도 위반이다.',
        },
        schema: [],
      },
      create(context) {
        const required = new Set([
          "isCommonExcludedContent",
          "isEtfOrEtpContent",
          "isEsgContent",
          "isFxContent",
          "isCommodityContent",
          "isWeeklyRecurringContent",
          "isDigitalAssetContent",
        ]);
        let found = false;
        return {
          CallExpression(node) {
            if (node.callee.type === "Identifier" && required.has(node.callee.name)) found = true;
          },
          "Program:exit"(node) {
            if (!found) context.report({ node, messageId: "missing" });
          },
        };
      },
    },
  },
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // 매출·매출원가·매출총이익·판관비·연구개발비 태그 직접 사용 금지. 문서화된 예외(표시 값이 아닌 판정·구조 보조 — architecture.md §1 표):
  //  - edgar-series.ts        액면분할 판정(splitFactorsByYear) 휴리스틱
  //  - edgar-ev.ts            모기지 리츠 판정(이자수익 ÷ 매출 비중)
  //  - edgar-foreign.ts       IFRS → us-gaap 개념 매핑·보고 통화 판정(판독 단계)
  //  - edgar-is-structure.ts  영업이익 소계 없는 손익계산서의 계산 구조 대입(영업이익 합성)
  //  - edgar-revenue-dims.ts  총수익 안 비영업 수익 분리(영업이익 EBIT 근사용 — 매출 태그는 만들지 않음)
  //  - verify-financials.mjs  독립 검증기(SEC 원자료를 직접 읽어야 함, S3)
  {
    files: ["src/**/*.{ts,tsx}", "scripts/**/*.{ts,mjs}"],
    ignores: [
      "src/lib/fin/**",
      "scripts/fin/**",
      "scripts/verify-financials.mjs",
      "src/lib/markets/us/edgar-series.ts",
      "src/lib/markets/us/edgar-ev.ts",
      "src/lib/markets/us/edgar-foreign.ts",
      "src/lib/markets/us/edgar-is-structure.ts",
      "src/lib/markets/us/edgar-revenue-dims.ts",
    ],
    rules: { "no-restricted-syntax": ["error", ...REVENUE_TAG_RULES, ...COGS_TAG_RULES, ...SGA_TAG_RULES] },
  },
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
        // 같은 규칙 이름이라 위(전역) 설정을 덮어쓴다 — 매출·매출원가·매출총이익 태그 금지도 여기에 함께
        ...REVENUE_TAG_RULES,
        ...COGS_TAG_RULES,
        ...SGA_TAG_RULES,
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
  // 리서치 수집기 공통 lib 강제(오너 지시 2026-09-25 — "공통lib은 개별
  // 수집기가 무조건 베껴야 하는 법규다"): ETF/ESG/FX/원자재 판정은
  // scripts/lib/exclude-filters.mjs 의 isEtfOrEtpContent·isEsgContent·
  // isFxContent·isCommodityContent 로만 한다. 개별 수집기가 같은 이름의
  // 정규식을 직접 선언하는 게 이번 세션에서 발견된 구멍(FX_RE 등)의
  // 반복 원인이었다 — 재발하면 빌드가 실패하도록 막는다.
  {
    files: ["scripts/collect-*.mjs"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "VariableDeclarator > Identifier.id[name=/^(ETF_RE|ESG_RE|FX_RE|COMMODITY_RE|DIGITAL_ASSET_RE|KR_DIGITAL_ASSET_RE)$/]",
          message:
            "ETF/ESG/FX/원자재/디지털자산 판정용 정규식을 이 파일에서 직접 선언하지 말 것 — scripts/lib/exclude-filters.mjs 의 isEtfOrEtpContent·isEsgContent·isFxContent·isCommodityContent·isDigitalAssetContent(또는 isCommonExcludedContent) 를 가져다 쓴다(공통 lib 강제).",
        },
      ],
    },
  },
  {
    files: ["scripts/collect-*.mjs"],
    ignores: [
      "scripts/collect-analyst-forecasts.mjs",
      "scripts/collect-foreign-fut.mjs",
      "scripts/collect-telegram-posts.mjs",
    ],
    plugins: { local: localRules },
    rules: {
      "local/require-common-lib-call": "error",
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
