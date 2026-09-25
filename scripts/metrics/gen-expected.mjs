// 예상 변경 목록 생성 — 설계(D1·D2·D4·D5·유니버스 LTM)에서 정한 칸만. 값이 아니라 구조(열 라벨·행 이름)로 경로를 찾는다.
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
const [A, B, OUT] = process.argv.slice(2);
const D1 = ["MET", "AXP", "GM", "WMT", "XOM", "BE", "VST", "CEG", "OXY", "GS", "MS"];
const D2 = ["XOM", "CVX", "AXP", "GS", "MS"];
const rules = [];
const add = (symbol, endpoint, pathPrefix, note) => rules.push({ symbol, endpoint, pathPrefix, note });
const load = (d, s, e) => { const f = path.join(d, s, `${e}.json`); return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null; };

add("*", "verify-row", "universe.updatedAt", "유니버스 행 계산 시각(값 아님)");
for (const k of ["revenueAnnual", "opMargin", "netMargin"])
  add("*", "verify-row", `universe.${k}`, "유니버스 매출·마진 = LTM(오너 결정 2026-09-25) + D1(부분 매출 태그 → fin 매출)");
for (const s of D1) add(s, "verify-row", "overview.multiples.inputs.revenueAnnual", "D1 — 개요 연간 매출이 부분 매출 태그(고객계약 매출 우선)였음 → fin 매출");

const syms = readdirSync(A).filter((s) => existsSync(path.join(A, s, "_meta.json")));
for (const s of syms) {
  // D5 — 분기 Q4 열(손익·재무상태표·총괄): 열 목록과 새로 생긴/밀려난 열 칸만
  for (const e of ["financials-is-quarter", "financials-bs-quarter", "financials-summary-quarter"]) {
    const a = load(A, s, e), b = load(B, s, e);
    if (!a || !b) continue;
    const la = a.periods.map((p) => p.label), lb = b.periods.map((p) => p.label);
    // 같은 라벨이 다른 결산일을 가리키던 열(옛 라벨 = SEC dei fy 기준 — ORCL "2026 Q1"@2026-08-31, XOM 재무상태표 "2025 Q2"@2024-06-30)
    const endA = new Map(a.periods.map((p) => [p.label, p.endDate])), endB = new Map(b.periods.map((p) => [p.label, p.endDate]));
    const relabeled = lb.filter((l) => endA.has(l) && endA.get(l) !== endB.get(l));
    const changed = [...la.filter((l) => !lb.includes(l)), ...lb.filter((l) => !la.includes(l)), ...relabeled];
    if (!changed.length) continue;
    add(s, e, "periods", "D5 — 분기 열에 Q4(사업연도 − 9개월 누적) 추가로 열 목록 변경");
    b.sections.forEach((sec, si) => sec.items.forEach((_, ii) => {
      for (const l of changed) add(s, e, `sections[${si}].items[${ii}].values.${l}`, `D5 — ${lb.includes(l) ? "새 열" : "밀려난 열"} ${l}`);
    }));
  }
  // D2(+D1 원인 동일) — 컨센서스 실적 매출·성장률
  if (D2.includes(s) || D1.includes(s)) {
    const b = load(B, s, "consensus");
    b?.rows?.forEach((_, i) => {
      add(s, "consensus", `rows[${i}].revenue`, "D2 — 컨센서스 실적 매출이 부분 매출 태그 → fin 매출");
      add(s, "consensus", `rows[${i}].revenueYoY`, "D2 — 매출이 분모·분자인 성장률");
    });
  }
}
// D4 — WDC 분기 매출 최신 판본 + 매출을 쓰는 파생 행(손익·총괄 분기)
for (const e of ["financials-is-quarter", "financials-summary-quarter"]) {
  const b = load(B, "WDC", e);
  b?.sections.forEach((sec, si) => sec.items.forEach((it, ii) => {
    if (/^(매출액|매출총이익|\(−\) 영업비용|\(−\) 기타 영업비용|영업비용)$/.test(it.accountName))
      add("WDC", e, `sections[${si}].items[${ii}].values`, `D4 — 분기 매출 원공시 → 최신 판본(${it.accountName})`);
  }));
}
// ② 판본·정의 차이 — 매출 연도 시계열의 옛 값이 원공시·다른 정의였던 해(원자료로 분해식 확인). 매출이 분모·분자인 파생(성장률·CAGR·
//    은행 충당금전이익 기반 영업이익·EBITDA 성장률)도 같이 바뀐다.
const ANALYSIS_GROWTH = ["매출액", "EBITDA", "영업이익"];
const secondFix = [
  ["JPM", "② 판본 — 옛 은행 순수익 합성이 같은 기간 첫 공시만 남겨 FY2020 = 119,543(10-K 2021-02, accn 0000019617-21-000236). 새 = 최신 판본 119,951(accn 0000019617-22-000272·-23-000231). 2021 성장률·3년 CAGR(2018~2020 기준값) 동반 변경"],
  ["XOM", "② 정의 — 옛 FY2018~2020 매출 = 총수익(Revenues, 2020 181,502 = 영업 매출 178,574 + 지분법·기타수익 2,928, accn 0000034088-23-000020). 새 = 전 연도 영업 매출(overrides.ts revenue-excl-nonop). 2021 성장률·3년 CAGR 동반 변경"],
  ["VRT", "② 판본 — 옛 FY2018·2019 = SPAC 전신 GS Acquisition Holdings Revenues 0(10-K 2019·2020) → CAGR 빈칸. 새 = 최신 판본(10-K/A 2021-04, accn 0001628280-21-008318: 2018 4,285.6 / 10-K 2022 accn 0001628280-22-004533: 2019 4,431.2)로 3년 CAGR 계산됨"],
];
for (const [s, note] of secondFix) {
  for (const e of ["financials-analysis-annual", "financials-analysis-quarter"]) {
    const b = load(B, s, e);
    b?.sections.forEach((sec, si) => sec.items.forEach((it, ii) => {
      if (ANALYSIS_GROWTH.includes(it.accountName) && ii > 60) add(s, e, `sections[${si}].items[${ii}].values`, note);
    }));
  }
  const h = load(B, s, "highlights")?.highlights;
  h?.rows.forEach((r, ri) => { if (/_yoy$/.test(r.key)) add(s, "highlights", `highlights.rows[${ri}].values`, note); });
}
// 옛 분기 달력 결함의 파생 — 옛 라벨(SEC dei fy)이 겹쳐 열이 사라지거나 다른 해를 가리킨 경우
//  - ORCL: 옛 "2026 Q1" 이 2026-08-31(실제 2027 Q1)을 가리켜 2025-08-31 분기가 빠짐 → 2026 Q2 의 누적 차감 직전 열이 전 사업연도
//    3분기가 되어 감가상각비가 6개월 누적(Depreciation 3,055 + 무형상각 3개월 407 = 3,462)으로 들어감. 새 = 3,055 − 1,351 + 407 = 2,111
//    (10-Q accn 0001193125-25-315925·-25-200095). EBITDA 동반
//  - XOM 총괄 분기의 재무상태표 칸: 옛 재무상태표 분기 "2025 Q2" 가 2024-06-30 을 가리켰음 → 새 = 2025-06-30
{
  const b = load(B, "ORCL", "financials-is-quarter");
  b?.sections[0].items.forEach((it, ii) => { if (/^(EBITDA|감가상각비)$/.test(it.accountName)) add("ORCL", "financials-is-quarter", `sections[0].items[${ii}].values.2026 Q2`, "옛 분기 달력 결함(라벨 겹침) — 2026 Q2 감가상각비가 6개월 누적이었음"); });
  for (let ii = 0; ii < 4; ii++) add("XOM", "financials-summary-quarter", `sections[1].items[${ii}].values.2025 Q2`, "옛 재무상태표 분기 달력 결함 — \"2025 Q2\" 가 2024-06-30 을 가리켰음");
}
// 외부 데이터 갱신(매출 무관) — Yahoo 가격 이력(베타)·공매도·목표주가, 외화 공시사 예상치의 "현재 환율" 갱신(DKK·EUR·TWD·SEK)
add("*", "ttm", "beta.", "외부 — Yahoo 가격 이력 재조정(52주 베타·최고·최저 소수점 이하 변화)");
for (const k of ["shortRatio", "shortPercentSharesOut", "targetMeanPrice", "targetHighPrice", "targetLowPrice"]) add("*", "overview", `consensus.${k}`, "외부 — Yahoo 컨센서스 갱신");
add("*", "verify-row", "universe.targetMeanPrice", "외부 — Yahoo 컨센서스 갱신");
for (const s of ["ASML", "NVO", "SAP", "SPOT", "TSM"]) {
  const note = "외부 — 외화 공시사 예상치·목표가를 '현재 환율'로 환산(환율 갱신, 모든 칸 같은 비율)";
  for (const k of ["targetPrice", "epsRevision", "earningsSurprise", "notes"]) add(s, "consensus", k, note);
  load(B, s, "consensus")?.rows.forEach((r, i) => { if (r.isEstimate) add(s, "consensus", `rows[${i}]`, note); else add(s, "consensus", `rows[${i}].revenueYoY`, note + " — 다음 해가 예상 행"); });
  const h = load(B, s, "highlights")?.highlights;
  h?.columns.forEach((c, ci) => {
    if (c.kind !== "estimate") return;
    h.rows.forEach((_, ri) => add(s, "highlights", `highlights.rows[${ri}].values[${ci}]`, note));
    h.valuationRows.forEach((_, ri) => add(s, "highlights", `highlights.valuationRows[${ri}].values[${ci}]`, note));
    // 예상 첫 해 성장률 = 예상 ÷ 직전 실적
  });
  h?.notes.forEach((_, i) => add(s, "highlights", `highlights.notes[${i}]`, note));
}
// 부동소수 합산 순서만 다른 칸(상대 차이 < 1e-12 — 화면 표시값 동일): 외화 공시사 LTM(분기 환산 합)
for (const s of syms) for (const f of readdirSync(path.join(B, s)).filter((f) => f.endsWith(".json") && f !== "_meta.json")) {
  const e = f.replace(/\.json$/, "");
  const walk = (x, y, p) => {
    if (typeof x === "number" && typeof y === "number") { if (x !== y && Math.abs(y / x - 1) < 1e-12) add(s, e, p, "부동소수 합산 순서(1ULP 수준, 표시값 동일)"); return; }
    if (x && y && typeof x === "object" && typeof y === "object")
      for (const k of Object.keys(y)) walk(x[k], y[k], Array.isArray(y) ? `${p}[${k}]` : p ? `${p}.${k}` : k);
  };
  const a = load(A, s, e), b = load(B, s, e);
  if (a && b) walk(a, b, "");
}
writeFileSync(OUT, JSON.stringify(rules, null, 1));
console.log(`${rules.length} rules`);
