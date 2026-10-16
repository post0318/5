/**
 * 출력 형식(설계 10 §2) — RawFact(원자료 사실 한 건, 손실 없는 기록)·Item(정규화 항목)·Filing·Event·MarketDay·FxRate·FetchLog.
 * 세 시장이 같은 형식을 쓴다. 숫자는 부동소수로 바꾸지 않는다: 금액은 원 단위 정수 문자열, 주당 값·비율은 원문 소수 문자열.
 */

/** 원문 숫자 문자열 → 정규 문자열(앞뒤 공백·천 단위 쉼표 제거, "+" 제거, 소수점 뒤 0 만 있으면 정수로). 숫자가 아니면 null */
export function normNum(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().replace(/,/g, "");
  if (s === "") return null;
  if (/^[+-]?\d+(\.\d+)?[eE][+-]?\d+$/.test(s)) {
    // 지수 표기 — 정수로 정확히 풀리면 정수 문자열, 아니면 원문 유지(판단은 ④)
    const [m, e] = s.toLowerCase().split("e");
    const neg = m.startsWith("-");
    const digits = m.replace(/^[+-]/, "");
    const [ip, fp = ""] = digits.split(".");
    const exp = Number(e);
    if (exp >= fp.length) s = `${neg ? "-" : ""}${(ip + fp + "0".repeat(exp - fp.length)).replace(/^0+(?=\d)/, "")}`;
    else return s;
  }
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return null;
  s = s.replace(/^\+/, "");
  if (s.includes(".")) s = s.replace(/\.?0+$/, "");
  if (s === "-0") s = "0";
  return s;
}

/** 정수 문자열 × 10^k (표 단위 배수 — 천원 = 3) */
export function scaleInt(numStr, k) {
  if (numStr == null) return null;
  if (!k) return numStr;
  const neg = numStr.startsWith("-");
  const d = numStr.replace(/^-/, "");
  const [ip, fp = ""] = d.split(".");
  if (fp.length > k) return null; // 배수 뒤에도 소수 — 정수가 아님(판독 오류 신호)
  const out = (ip + fp.padEnd(k, "0")).replace(/^0+(?=\d)/, "");
  return out === "0" ? "0" : `${neg ? "-" : ""}${out}`;
}

const DAY = 864e5;
/** 기간 길이(개월, 반올림) */
export function monthsBetween(start, end) {
  if (!start || !end) return null;
  return Math.round((Date.parse(end) - Date.parse(start) + DAY) / DAY / 30.4375);
}

/** 시장별 기간 열쇠(결산일 연도). 미국: 결산일이 1월 1~7일이면 전년도(52/53주 결산) */
export function fyKey(market, end) {
  if (!end) return null;
  const y = Number(end.slice(0, 4)), mo = Number(end.slice(5, 7)), d = Number(end.slice(8, 10));
  if (market === "us" && mo === 1 && d <= 7) return y - 1;
  return y;
}

const REQ = ["market", "entity", "filing", "concept", "period", "scope", "value", "locator"];
/** RawFact 만들기 — 필수 칸 확인 */
export function rawFact(o) {
  for (const k of REQ) if (o[k] == null) throw new Error(`RawFact 필수 칸 없음: ${k}`);
  return {
    market: o.market,
    entity: o.entity,
    filing: o.filing,
    concept: o.concept,
    placement: o.placement ?? null,
    period: o.period,
    scope: o.scope,
    value: o.value,
    vintage: o.vintage ?? null,
    locator: o.locator,
    fetch: o.fetch ?? null,
  };
}

/** 빈칸 사유 코드(§3.4) */
export const BLANK = Object.freeze({
  fetch_failed: "fetch_failed",
  quota_stop: "quota_stop",
  source_maintenance: "source_maintenance",
  not_yet_published: "not_yet_published",
  parse_failed: "parse_failed",
  ambiguous: "ambiguous",
  confirmed_absent: "confirmed_absent",
  out_of_scope: "out_of_scope",
  definition_blank: "definition_blank",
});
/** 판정 연결(§3.4 표) — ⑥ 이 이 표를 따른다 */
export const BLANK_JUDGE = Object.freeze({
  fetch_failed: { judge: "unverifiable", exit: 1 },
  quota_stop: { judge: "unverifiable", exit: 1 },
  source_maintenance: { judge: "unverifiable", exit: 1 },
  not_yet_published: { judge: "unverifiable_rerun", exit: 3 },
  parse_failed: { judge: "unverifiable", exit: 1 },
  ambiguous: { judge: "unverifiable", exit: 1 },
  confirmed_absent: { judge: "expected_blank", exit: 0 },
  out_of_scope: { judge: "expected_blank", exit: 0 },
  definition_blank: { judge: "expected_blank", exit: 0 },
});

/** Item 만들기 — 값 또는 빈칸(사유 필수) */
export function item(o) {
  if (!o.key || !o.period || !o.rule) throw new Error("Item 필수 칸(key·period·rule) 없음");
  const blank = o.value == null;
  if (blank && !BLANK[o.blank_reason]) throw new Error(`Item 빈칸 사유 코드 없음/틀림: ${o.key} ${o.blank_reason}`);
  if (!blank && o.blank_reason) throw new Error(`Item 값과 빈칸 사유가 함께 있음: ${o.key}`);
  return {
    key: o.key,
    period: o.period,
    scope: o.scope ?? null,
    value: blank ? null : o.value,
    blank_reason: blank ? o.blank_reason : null,
    blank_detail: o.blank_detail ?? null,
    facts: o.facts ?? [],
    rule: o.rule,
    vintage_basis: o.vintage_basis ?? null,
    rule_shared_with_app: !!o.rule_shared_with_app,
    flags: o.flags ?? {},
  };
}

/**
 * 같은 개념·문맥·단위 사실이 정밀도만 달리 여러 번(본문 문장 "$7.6 billion" 을 decimals=-8 로 다시 태깅 — ORCL 2026 10-K) —
 * 가장 정밀한 값(decimals 가 가장 큰 값, INF 최고)만 남기고 나머지는 value.less_precise_duplicate 로 표시(지우지 않음).
 * 정밀도까지 같은데 값이 다르면 둘 다 value.inconsistent_duplicate(판독 모호 — Item 은 빈칸 ambiguous).
 */
export function markPrecisionDuplicates(facts) {
  const prec = (d) => (d == null ? -Infinity : d === "INF" ? Infinity : Number(d));
  const groups = new Map();
  for (const f of facts) {
    if (!f.locator.contextRef || f.value.num == null) continue;
    const k = `${f.concept.id}|${f.locator.contextRef}|${f.value.unit}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const top = Math.max(...g.map((f) => prec(f.value.decimals)));
    const best = g.filter((f) => prec(f.value.decimals) === top);
    const vals = new Set(best.map((f) => f.value.num));
    for (const f of g) {
      if (prec(f.value.decimals) < top) f.value.less_precise_duplicate = true;
      else if (vals.size > 1) f.value.inconsistent_duplicate = true;
    }
  }
}

/**
 * 반올림 재태깅(설계 R-US1) 판정 — RawFact 판본 표시(us/read)와 Item 판본 표시(us/items)가 같은 규칙을 쓴다(감사 10-16 3차 — 두 곳 규칙이 달라
 * RawFact 쪽은 첫 값 절댓값이 5천만 미만이면 나중 값 0 을 「1억 반올림」으로, 개수 단위 개념(NumberOfPositions)도 표시했다).
 * 금액(ISO 통화) 사실만, 첫 값 절댓값이 단위 이상일 때, 나중 값 = 첫 값을 1억·10억·100억 단위로 반올림한 값(≠ 첫 값)이면 그 단위.
 */
export function roundedRetagUnit(first, later, isMoney) {
  if (!isMoney) return null;
  const v0 = Number(first), v = Number(later);
  if (!Number.isFinite(v0) || !Number.isFinite(v) || v === v0) return null;
  for (const u of [1e8, 1e9, 1e10]) if (Math.abs(v0) >= u && v === Math.round(v0 / u) * u) return u;
  return null;
}

/**
 * 표시 통화(설계 R-US8) — 서류마다 차원 없는 금액 사실이 가장 많은 ISO 통화를 그 서류의 표시 통화로 보고, 다른 통화 금액 사실에
 * value.non_presentation_currency, 같은 개념·기간의 표시 통화 사실이 있으면 value.convenience(20-F 「편의 환산」 USD)를 붙인다(지우지 않음).
 * Item 은 표시 통화 사실만 쓴다(감사 10-16 2차 ③-3 — TSM 20-F 유형자산 취득 2024 가 USD 29,155,400,000 으로 나왔다).
 * 가장 많은 통화가 둘 이상 같으면 표시 통화를 정하지 않고 value.presentation_currency_unknown.
 */
export function markPresentationCurrency(facts) {
  const MONEY = /^[A-Z]{3}$/;
  const by = new Map();
  for (const f of facts) {
    if (!MONEY.test(f.value.unit ?? "")) continue;
    const k = f.filing.id;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(f);
  }
  for (const fs of by.values()) {
    const cnt = new Map();
    for (const f of fs) if (!f.scope.dims.length) cnt.set(f.value.unit, (cnt.get(f.value.unit) ?? 0) + 1);
    const top = Math.max(0, ...cnt.values());
    const tops = [...cnt].filter(([, n]) => n === top).map(([u]) => u);
    if (tops.length !== 1) { for (const f of fs) f.value.presentation_currency_unknown = true; continue; }
    const pres = tops[0];
    const presKeys = new Set(fs.filter((f) => f.value.unit === pres).map((f) => `${f.concept.id}|${f.period.start ?? ""}|${f.period.end}|${JSON.stringify(f.scope.dims)}`));
    for (const f of fs) {
      f.value.presentation_currency = pres;
      if (f.value.unit === pres) continue;
      f.value.non_presentation_currency = true;
      if (presKeys.has(`${f.concept.id}|${f.period.start ?? ""}|${f.period.end}|${JSON.stringify(f.scope.dims)}`)) f.value.convenience = true;
    }
  }
  return facts;
}

/** Item 에 쓸 수 있는 금액 사실인가(표시 통화) — 통화가 아닌 단위(주식수·주당)는 그대로 통과 */
export const presentationOk = (f) => !f.value.non_presentation_currency && !f.value.presentation_currency_unknown;
