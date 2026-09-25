import type { RawFact } from "../types";

/**
 * 1층 — 판본 선택(architecture.md §1, revenue.md §2). **판본 규칙은 이 파일 한 곳.**
 *
 * 규칙: 같은 개념·단위·기간(start·end)·차원의 값이 여러 공시에 있으면 **가장 최근 정기공시(최신 판본)** 를 쓴다 —
 * 연간·분기·누적 모두 같은 규칙(`markets/us/edgar-series.ts` preferNewer). 단, 나중 공시가 먼저 공시된 정밀값을
 * 반올림한 값으로 다시 태깅한 경우는 그 반올림값을 후보에서 버린다(dropRoundedRetags — 같은 파일에서 옮김, 규칙 동일).
 * 8-K·DEF 14A 등 비정기 공시는 후보가 아니다.
 */

const PERIODIC = /^(10-[QK]|20-F|40-F)(\/A)?$|^YAHOO-Q$/;

export function isPeriodic(f: RawFact): boolean {
  return PERIODIC.test(f.prov.form);
}

const usdRounds = (x: number, y: number) =>
  Math.abs(x) >= 1e8 && x !== y && [1e6, 1e8, 1e9, 1e10].some((p) => Math.round(y / p) * p === x && y % p !== 0);
const sharesRounds = (x: number, y: number) =>
  x !== y && [1e3, 1e4, 1e5, 1e6].some((p) => Math.abs(x) >= 100 * p && Math.round(y / p) * p === x && y % p !== 0);

/**
 * 반올림 재태깅 제거 — 같은 기간 그룹 안에서 먼저 공시된 값 y 를 1e6·1e8·1e9·1e10 단위로 반올림한 값과 정확히 같은
 * 나중 값 x 를 버린다(상세 근거: edgar-series.ts dropRoundedRetags 주석 — AXP 2021 총자산, MCD 2022 총자산 등).
 * 통화 단위는 USD 뿐 아니라 모든 통화(원통화 공시에도 같은 현상)에 적용한다.
 */
export function dropRoundedRetags(facts: RawFact[]): RawFact[] {
  const groups = new Map<string, RawFact[]>();
  for (const f of facts) {
    const k = `${f.unit}|${f.start ?? ""}|${f.end}|${JSON.stringify(f.dims)}`;
    const g = groups.get(k);
    if (g) g.push(f);
    else groups.set(k, [f]);
  }
  const drop = new Set<RawFact>();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const rounds = g[0].unit === "shares" ? sharesRounds : /^[A-Z]{3}$/.test(g[0].unit) ? usdRounds : null;
    if (!rounds) continue;
    for (const x of g) if (g.some((y) => (y.prov.filed ?? "") < (x.prov.filed ?? "") && rounds(x.val, y.val))) drop.add(x);
  }
  return drop.size ? facts.filter((f) => !drop.has(f)) : facts;
}

/** 두 후보 중 더 최신 판본인가(같은 기간 전제) — 제출일, 동률이면 accn 사전순 뒤 */
export function newer(a: RawFact, b: RawFact): boolean {
  const fa = a.prov.filed ?? "", fb = b.prov.filed ?? "";
  if (fa !== fb) return fa > fb;
  return (a.prov.accn ?? "") > (b.prov.accn ?? "");
}

/** 후보 중 최신 판본 하나(정기공시만). 없으면 null */
export function latest(cands: RawFact[]): RawFact | null {
  let best: RawFact | null = null;
  for (const c of cands) if (isPeriodic(c) && (!best || newer(c, best))) best = c;
  return best;
}

/** 특정 공시(accn)의 값 — 그 공시에 값이 없으면 null */
export function inFiling(cands: RawFact[], accn: string): RawFact | null {
  return cands.find((c) => c.prov.accn === accn) ?? null;
}
