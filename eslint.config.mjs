import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

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
