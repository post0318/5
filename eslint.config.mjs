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
