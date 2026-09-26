import type { FormType, RawFact } from "../types";

/**
 * 1층 — 판본 선택(architecture.md §1, revenue.md §2). **판본 규칙은 이 파일 한 곳.**
 *
 * 규칙: 같은 개념·단위·기간(start·end)·차원의 값이 여러 공시에 있으면 **가장 최근 정기공시(최신 판본)** 를 쓴다 —
 * 연간·분기·누적 모두 같은 규칙(`markets/us/edgar-series.ts` preferNewer). 단, 최신 판본이 앞선 공시 값을 정밀도만 낮춰 다시 실은
 * 것이면 **열 전체**를 앞선 정밀 공시에서 읽는다(columnFiling — 줄마다 판본을 섞지 않는다, architecture.md §1.1).
 * dropRoundedRetags(줄 단위 반올림 재태깅 제거)는 열 값 판독이 아닌 증거 조회에만 남는다.
 * 8-K·DEF 14A 등 비정기 공시는 후보가 아니다.
 */

const PERIODIC = /^(10-[QK]|20-F|40-F)(\/A)?$|^YAHOO-Q$/;

export function isPeriodic(f: RawFact): boolean {
  return PERIODIC.test(f.prov.form);
}

// 반올림 단위에 1e3·1e4·1e5 추가(2026-09-26) — MRVL FY2022 매출: 원공시 4,462,383,000 → 이후 10-K 4,462,400,000(10만 달러
// 반올림)을 놓쳐 반올림값을 썼다(인포맥스 대조로 발견, 검증기도 같은 목록이라 공통 맹점). 추가 단위는 값이 그 단위의 100배 이상일 때만
// (상대 0.5% 이하 — 주식수 규칙과 같은 폭). 1e7 은 뺐다 — AXP FY2017 충당금 2,759 → 2,760 은 1e7 반올림처럼 보이지만 구성 항목(기타
// 충당금 96 → 97)이 바뀐 실제 재작성이었다(2019 10-K). 줄 하나로는 반올림과 재작성을 못 가른다.
// **열 값 판독에는 이 줄 단위 규칙을 쓰지 않는다** — 표시 단위 재게시는 열 단위(columnFiling)로 판정한다(§1.1). 여기 규칙은 판본과
// 무관한 증거 조회(facts())와 같은 공시 안 중복 사실(mostPrecise)에만.
const usdRounds = (x: number, y: number) =>
  x !== y && ((Math.abs(x) >= 1e8 && [1e6, 1e8, 1e9, 1e10].some((p) => Math.round(y / p) * p === x && y % p !== 0)) ||
    [1e3, 1e4, 1e5].some((p) => Math.abs(x) >= 100 * p && Math.round(y / p) * p === x && y % p !== 0));
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

/**
 * 같은 공시·같은 기간·같은 차원에 값이 둘 이상이면 가장 정밀한 것 — 본문 문장용 반올림 사실(decimals −8 "2.4 billion")이 정밀값과
 * 함께 태깅되는 경우(DAL 감가상각비 정밀 2,443 · 문장 2,400 — cogs.md §6). decimals 가 있으면 큰 쪽(INF = null 이 가장 정밀),
 * 없으면(companyfacts) 다른 값의 반올림인 값을 버린다. 후보가 없으면 null.
 */
export function mostPrecise(cands: RawFact[]): RawFact | null {
  if (cands.length < 2) return cands[0] ?? null;
  const prec = (f: RawFact) => (f.decimals == null ? Infinity : f.decimals);
  const pool = cands.filter((x) => !cands.some((y) => y !== x && x.val !== y.val && (prec(y) > prec(x) || usdRounds(x.val, y.val) || sharesRounds(x.val, y.val))));
  return pool[0] ?? cands[0];
}

/**
 * 열 판본 비교용 — 한 공시가 한 기간(start·end)에 실은 차원 없는 통화 값들. lines 키 = `개념|단위`.
 * decimals = 그 공시 사실들의 가장 정밀한 decimals(인스턴스로 읽은 공시만 — companyfacts 는 null. 본문 문장 사실의 −8 등이 표시 단위를
 * 거칠게 만들지 않게 최댓값).
 */
export interface FilingLines { accn: string; form: FormType; filed: string; lines: Map<string, number>; decimals: number | null }

/** 공시 표시 단위 후보(천·만·10만·백만) — 정밀값을 이 단위로 다시 실은 비교 열(MRVL 2023 10-K 의 FY2021 = 10만 달러) */
const PRES_UNITS = [1e6, 1e5, 1e4, 1e3];
/** 원래 반올림 재태깅 규칙(1e6·1e8·1e9·1e10, 값 1억 이상) — 본문 문장 재태깅("$189 billion")은 표시 단위와 무관한 한 줄이라 따로 */
const sentenceRounds = (x: number, y: number) =>
  Math.abs(x) >= 1e8 && x !== y && [1e6, 1e8, 1e9, 1e10].some((p) => Math.round(y / p) * p === x && y % p !== 0);

/** 공시의 표시 단위 — decimals 가 있으면 10^−decimals, 없으면 0 아닌 모든 값을 나누는 가장 큰 후보 단위. 없으면 null */
function presUnit(f: FilingLines): number | null {
  if (f.decimals != null) return f.decimals < 0 ? 10 ** -f.decimals : null;
  const vs = [...f.lines.values()].filter((v) => v !== 0);
  return vs.length ? PRES_UNITS.find((p) => vs.every((v) => v % p === 0)) ?? null : null;
}

/**
 * companyfacts 값 x 가 먼저 공시된 같은 기간 값의 본문 문장 반올림(sentenceRounds)인가 — companyfacts 는 한 공시·기간·개념에 값 하나만
 * 남겨서, 공시가 본표 정밀값(DELL 2025-06 10-Q 의 2025Q1 법인세 −408)과 본문 문장값("$0.4 billion" −400)을 함께 태깅하면 문장값만 남는
 * 경우가 있다. 그러면 그 공시 원본(인스턴스)에서 정밀값을 다시 읽는다(read/index.ts partValue — 다른 판본 값으로 바꾸지 않는다).
 */
export function sentenceRetagged(x: RawFact, cands: RawFact[]): boolean {
  return cands.some((y) => y.unit === x.unit && (y.prov.filed ?? "") < (x.prov.filed ?? "") && sentenceRounds(x.val, y.val));
}

/**
 * 나중 공시 later 가 먼저 공시 earlier 의 같은 기간 값을 **정밀도만 낮춰 다시 실은 것**인가(scope 를 주면 그 개념 줄만 비교).
 * 다른 공유 줄 하나하나를 셋으로 나눈다.
 *  - 반올림 재게시: 나중 값이 나중 공시의 표시 단위 u 의 배수이고 먼저 값은 아니며, 먼저 값을 u 로 반올림한 값에서 한 단위 이내 —
 *    회사가 반올림된 항목으로 소계를 다시 계산하거나 합계를 맞추려 한 줄을 한 단위 조정한 경우 포함(MRVL FY2021 매출총이익
 *    2,968.9 − 1,480.6 = 1,488.3 ≠ round(1,488.35) = 1,488.4, FY2022 연구개발비 1,424.306 → 1,424.2). 부호 관례만 바꿔 다시 태깅한
 *    줄은 크기로 비교(MCD 2024 10-Q 의 2023Q1 기타영업손익 −128.6 → 129). 본문 문장 재태깅(sentenceRounds)도 여기.
 *  - 부호만 바뀜(크기 같음 — MCD 9개월 영업외손익 163 → −163): 새 정보가 아니고 정밀도 차이도 아니라 판정에 넣지 않는다.
 *  - 재작성: 그 밖의 차이(AXP 2019 10-K 의 FY2017: 매출 33,471 → 36,878 백만 달러).
 * → "rounded"(재게시만 하나 이상) · "same"(공유 줄 없음·전부 같음·부호만) · "restated"(재작성만) · "mixed"(둘 다).
 */
export function precisionRelation(later: FilingLines, earlier: FilingLines, scope?: Set<string>): "rounded" | "same" | "restated" | "mixed" {
  const u = presUnit(later);
  let rounded = 0, restated = 0;
  for (const [k, lv] of later.lines) {
    if (scope && !scope.has(k.slice(0, k.lastIndexOf("|")))) continue;
    const ev = earlier.lines.get(k);
    if (ev === undefined || ev === lv) continue;
    const la = Math.abs(lv), ea = Math.abs(ev);
    if (la === ea) continue;
    if (sentenceRounds(lv, ev) || (u != null && la % u === 0 && ea % u !== 0 && Math.abs(la - Math.round(ea / u) * u) <= u)) rounded++;
    else restated++;
  }
  return rounded && restated ? "mixed" : rounded ? "rounded" : restated ? "restated" : "same";
}

/**
 * **열 단위 판본 선택**(architecture.md §1.1) — 한 기간(열)의 값은 한 공시에서만 읽는다. 최신 판본 from 에서 시작해 더 이른 공시를
 * 최신순으로 보며, 지금 공시의 **손익계산서 본표 줄**(statementLines)로 판정한다: 이른 공시의 정밀도 낮춘 재게시("rounded")면 열 전체를
 * 이른 공시로 옮기고, 같으면 계속, 재작성이면(본표 안에서 섞여도) 멈춘다 — 최신 공시 그대로, 열 안에서 줄마다 판본을 섞지 않는다.
 * 본표로 좁히는 이유: 현금흐름표 재분류·주석 표의 태그 재사용은 손익계산서 열의 재작성이 아니고(MRVL 2024 10-K 의 FY2022: 재무활동
 * 기타 1.0 → −10.8 백만 달러, FY2021 주석 구조조정 141.9 → 27.0), 주석만 반올림되고 본표가 같으면 옮길 이유가 없다(ISRG).
 * 본표를 못 읽으면 전체 줄 판정이 "rounded" 일 때만 옮긴다. 공유 줄 전체가 같으면 본표를 읽지 않고 계속, 더 이른 공시 어디에도 반올림
 * 재게시 줄이 없으면 본표를 읽지 않고 멈춘다(SEC 요청 절약 — 결과는 같다).
 * 옮겨 갈 공시는 eligible(열 기준 줄 — 매출 등 — 을 실은 공시)만: 본문 문장에 숫자 하나만 다시 태깅한 공시(INTC 2025 10-K 의 2024
 * 9개월 값 1줄)는 열의 원천이 아니라 건너뛴다. filings = 그 기간을 실은 정기공시 전부. from 이 없으면 null.
 */
export async function columnFiling(
  filings: FilingLines[], from: string, statementLines: (f: FilingLines) => Promise<Set<string> | null>,
  eligible: (f: FilingLines) => boolean = () => true,
): Promise<FilingLines | null> {
  const all = [...filings].sort((a, b) => (a.filed !== b.filed ? (a.filed < b.filed ? 1 : -1) : a.accn < b.accn ? 1 : -1));
  const order = all.filter((f) => f.accn === from || eligible(f));
  const i = order.findIndex((f) => f.accn === from);
  if (i < 0) return null;
  let cur = order[i];
  for (let j = i + 1; j < order.length; j++) {
    const e = order[j];
    const r0 = precisionRelation(cur, e);
    if (r0 === "same") continue;
    if (!order.slice(j).some((x) => ["rounded", "mixed"].includes(precisionRelation(cur, x)))) break;
    const scope = await statementLines(cur);
    const r = scope ? precisionRelation(cur, e, scope) : r0 === "rounded" ? "rounded" : "restated";
    if (r === "rounded") cur = e;
    else if (r !== "same") break;
  }
  return cur;
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
