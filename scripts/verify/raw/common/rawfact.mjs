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
