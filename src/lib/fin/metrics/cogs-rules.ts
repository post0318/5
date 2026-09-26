/**
 * 3층 — 본표에 매출원가 줄이 없는 회사(유형 D)의 매출원가 구성 규칙(docs/metrics/cogs.md §3·§6). **회사별 규칙은 이 표 한 곳.**
 *
 * 오너 결정(2026-09-26): 유형 D 는 빈칸으로 두지 않는다 — 회사마다 본표 줄 조합(개념·부호)으로 매출원가를 정한다. 조합은 조사
 * 에이전트가 정하는 중이라 지금은 **대기(pending)** 로만 올려 둔다. 대기 종목은 매출원가·매출총이익을 비우고 사유
 * "구성 규칙 대기"를 단다(화면 주석에 그대로 표시).
 *
 * 규칙을 채울 때(`rule`):
 *  - terms: 그 회사 본표(손익계산서 표시 구조) 줄의 개념 id 후보와 부호. 열마다 모든 항의 값이 있어야 값을 낸다(하나라도 없으면 빈칸 + 사유)
 *  - label: 화면 주석에 쓰는 구성 설명(예: "원유·제품 매입 + 생산·제조비" — 화면에는 "구성: …" 로 붙는다)
 *  - evidence: 공시 accn 과 숫자(overrides.ts 와 같은 S2 규칙 — 없으면 로드 시 예외)
 *  - 매출총이익은 매출 − 이 매출원가로 합성한다("본표 소계 없음 · 매출 − 매출원가(구성: label)")
 */

export interface CogsTerm {
  /** 항 이름(표시·검증용, 예: "purch") */
  group?: string;
  /**
   * 본표 줄 개념 id 후보("us-gaap:…" · 회사 고유 "xom:…") — 공시마다 같은 줄의 개념 이름이 바뀌는 회사(ORCL·DAL·HLT·MAR)가 있어
   * 여럿을 둘 수 있다. 열마다 그 열 본표에 있는 첫 후보를 쓴다(조사 규칙표 scratchpad cogs-dtype/rules.json 의 composition 과 같은 형식)
   */
  concepts: string[];
  sign: 1 | -1;
}

export interface CogsRule {
  terms: CogsTerm[];
  label: string;
  /** 공시 accn 과 숫자로 된 근거 */
  evidence: string;
  since: string;
}

export interface CogsRuleEntry {
  symbol: string;
  /** null = 구성 규칙 대기(매출원가·매출총이익 빈칸 + 사유) */
  rule: CogsRule | null;
}

/** 유형 D(본표에 매출원가 줄 없음) — cogs.md §3 조사 결과 10종목. 규칙은 조사 완료 후 채운다.
 *  AXP 는 제외 — 카드·보험·은행은 금융사 기준(오너 2026-09-26, 앱 금융사 판정 SIC 60~64 과 같음): cogs.ts FIN_TYPES */
export const COGS_RULES: CogsRuleEntry[] = [
  { symbol: "XOM", rule: null },
  { symbol: "MCD", rule: null },
  { symbol: "V", rule: null },
  { symbol: "ORCL", rule: null },
  { symbol: "MAR", rule: null },
  { symbol: "HLT", rule: null },
  { symbol: "SBUX", rule: null },
  { symbol: "DAL", rule: null },
  { symbol: "CEG", rule: null },
  { symbol: "VST", rule: null },
];

const ACCN = /\d{10}-\d{2}-\d{6}/;
for (const e of COGS_RULES)
  if (e.rule && (!ACCN.test(e.rule.evidence) || !/\d{1,3}(,\d{3})+/.test(e.rule.evidence) || !e.rule.terms.length))
    throw new Error(`metrics/cogs-rules.ts: ${e.symbol} 매출원가 구성 규칙에 항·공시 accn·숫자 근거가 없습니다(S2)`);

/** 종목의 구성 규칙 항목 — 표에 없으면 null(본표 구조로 판정), 있으면 { rule: null } = 대기 */
export function cogsRuleFor(symbol: string): CogsRuleEntry | null {
  return COGS_RULES.find((e) => e.symbol === symbol.toUpperCase()) ?? null;
}
