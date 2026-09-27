/**
 * 3층 — 판관비·연구개발비 회사별 예외(docs/metrics/sga.md §1). **회사별 규칙은 이 표 한 곳.**
 *
 * 기본 규칙(2층 assemble/is.ts identifySgaRnd): 본표 영업이익 식(없으면 세전이익 식) 아래 줄 중 개념 이름(표준 개념) 또는 그 공시 자체
 * 라벨(회사 고유 개념)이 판관비·연구개발비 성격인 줄. 이 표는 그 규칙으로 가를 수 없는 회사만 적는다.
 *  - hints: 성격을 개념 이름·라벨로 알 수 없는 회사 고유 줄을 판관비(sga)·연구개발비(rnd)로 지정(오너 결정). 2층이 판정에 쓴다
 *  - exclude: 판관비를 비우는 회사(오너 결정 — 빈칸 + 사유). 사유 문구는 화면 각주에 그대로
 *  - evidence: 공시 accn 과 숫자(cogs-rules.ts 와 같은 S2 규칙 — 없으면 로드 시 예외)
 */

import type { SgaHint } from "../types";
export type { SgaHint };

export interface SgaRuleEntry {
  symbol: string;
  hint?: SgaHint;
  /** 판관비 빈칸 사유(오너 결정) */
  excludeSga?: string;
  evidence: string;
  since: string;
}

export const SGA_RULES: SgaRuleEntry[] = [
  {
    symbol: "AMZN",
    // 오너 결정 2026-09-28 — 판관비 = Fulfillment + Sales and marketing + General and administrative, "Technology and infrastructure" = 연구개발비
    hint: { sga: ["amzn:FulfillmentExpense"], rnd: ["amzn:TechnologyAndInfrastructureExpense"] },
    evidence: "10-K 0001018724-26-000004 FY2025: Fulfillment 109,074 + Sales and marketing 47,129 + General and administrative 11,172 = 167,375 · Technology and infrastructure 108,521",
    since: "2026-09-28",
  },
  {
    symbol: "NFLX",
    // FY2016~2019 본표 "Technology and development" 줄이 회사 고유 개념(라벨 판독 불가 — 개념 이름뿐) — FY2020 부터 같은 이름 줄이 us-gaap 연구개발비 개념
    hint: { rnd: ["nflx:TechnologyandDevelopmentExpense"] },
    evidence: "10-K 0001065280-26-000034 FY2025: Technology and development(us-gaap:ResearchAndDevelopmentExpense) 3,391,390 천 달러 — FY2019 이전 같은 줄은 nflx:TechnologyandDevelopmentExpense",
    since: "2026-09-28",
  },
  {
    symbol: "KO",
    // 오너 결정 2026-09-28 — KO 판관비 = SG&A + "Other operating charges". 같은 본표 줄을 10-K(2022~)는 OtherSellingGeneralAndAdministrativeExpense,
    // 10-Q 와 FY2021 이전 10-K 는 OtherCostAndExpenseOperating 으로 태깅 — 공시마다 태그가 달라도 같은 줄("Other operating charges")이라 지정
    hint: { sga: ["us-gaap:OtherCostAndExpenseOperating"] },
    evidence: "10-K 0001628280-26-010047 FY2025: Selling, general and administrative expenses 14,521 + Other operating charges 1,261(us-gaap:OtherSellingGeneralAndAdministrativeExpense) · 10-Q 0001628280-26-050503 같은 줄 = us-gaap:OtherCostAndExpenseOperating",
    since: "2026-09-28",
  },
  {
    symbol: "DAL",
    // 성격별 비용 손익계산서 — 판관비 소계·일반관리 줄 없이 판매 수수료 줄만(Passenger commissions and other selling expenses)
    excludeSga: "성격별 비용 본표 — 판관비 소계·일반관리비 줄 없음(판매 수수료 줄만, 오너 결정 2026-09-28)",
    evidence: "10-K 0000027904-26-000013 FY2025: Passenger commissions and other selling expenses 2,485 — 본표 비용 15줄 중 판관비 소계·일반관리 줄 없음",
    since: "2026-09-28",
  },
];

const ACCN = /\d{10}-\d{2}-\d{6}/;
for (const e of SGA_RULES)
  if (!ACCN.test(e.evidence) || !/\d{1,3}(,\d{3})+/.test(e.evidence) || (!e.hint && !e.excludeSga))
    throw new Error(`metrics/sga-rules.ts: ${e.symbol} 판관비 규칙에 공시 accn·숫자 근거·내용이 없습니다(S2)`);

export function sgaRuleFor(symbol: string): SgaRuleEntry | null {
  return SGA_RULES.find((e) => e.symbol === symbol.toUpperCase()) ?? null;
}
