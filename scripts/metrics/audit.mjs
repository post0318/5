// 관리자 검증 화면(/admin/verify)의 종목별 감사표 — 오너 결정 2026-09-26.
//
// 지표 12개 × (최근 사업연도 열 · LTM) 한 줄씩, 앱 값과 SEC 원자료·Yahoo·StockAnalysis·인포맥스 값을 나란히 두고 판정한다.
// 검증기(scripts/verify-financials.mjs)가 이미 계산한 값만 옮긴다 — 새 외부 조회 없음. 정의가 다른 값으로 칸을 채우지 않는다
// (그 칸은 null — 예: LTM 시가총액 칸에 인포맥스 "현재 주식수" 를 쓰지 않는다, 인포맥스 EV(현금 미차감)는 대조 제외).
//
// 판정: ① 일치 · ② 정의 차이(원인이 숫자로 확인됨 — 사유를 note 에) · ③ 오류(검사 실패, 닫힌 지표의 미규명 차이) ·
//      NA 대조값 없음 · 미결(닫히지 않은 지표의 원인 미규명 차이). 매출은 검증기의 revenueClass 를 그대로 따른다.
// 순수 함수 — 검증 결과 JSON 으로 따로 시험할 수 있게 검증기 밖에 둔다.

export const AUDIT_METRICS = ["매출", "영업이익", "순이익", "EPS", "BPS", "시가총액", "EV", "EBITDA", "PER", "PBR", "PSR", "EV/EBITDA"];
/** SEC 원자료 칸을 두지 않는 지표 — 배수는 원자료가 없다 */
const MULTIPLES = new Set(["PER", "PBR", "PSR", "EV/EBITDA"]);
/** 흐름(기간) 지표 — 기준 표기가 FY/TTM. 나머지는 시점(결산일·현재가) */
const FLOW = new Set(["매출", "영업이익", "순이익", "EPS", "EBITDA"]);
/** 외부 대조(F층) 항목 이름 — 열 이름 뒤에 붙는 부분. LTM 은 검증기가 따로 만드는 이름만 */
const EXT_ITEM = { 매출: "매출", 영업이익: "영업이익", 순이익: "순이익", EBITDA: "EBITDA", EPS: "희석 EPS", 시가총액: "시가총액(결산일)" };
const EXT_LTM = new Set(["매출", "영업이익", "순이익", "EBITDA"]);
const SRC_KEY = { Yahoo: "yahoo", StockAnalysis: "sa", 인포맥스: "infomax" };

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const clip = (s, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** 검사 이름에서 지표 이름만 남긴다 — "LTM 순이익 앱 = …"·"결산일 시가총액 앱 = …"·"20-F LTM 매출 = …" */
const stripName = (name) => name.replace(/^(20-F )?(LTM |결산일 )/, "");
/** 이 검사가 지표 m 에 관한 것인가 — 이름이 "m" 다음 공백·괄호·= 로 이어질 때만(EV ≠ EV/EBITDA, EBITDA 마진·성장률 제외) */
function about(c, m) {
  const n = stripName(c.name);
  if (!n.startsWith(m)) return false;
  const next = n[m.length];
  if (next !== " " && next !== "(" && next !== "=") return false;
  return !/마진|률|성장/.test(n.slice(m.length));
}

/**
 * @param {object} p
 * @param {Record<string, {date?: string} & Record<string, number|null>>} p.app  열(예 "2025Y"·"LTM") → 지표 → 앱 값 (+ date)
 * @param {string[]} p.cols      표에 넣을 열 — [최근 사업연도, "LTM"]
 * @param {any[]} p.checks       검증기 검사 행(layer·name·col·status·note·app·src)
 * @param {any[]} p.review       검증기 외부 대조 행(item·ours·sources·matched·explained·outliers·causes·definitionDiffs·revenueClass)
 * @param {string[]} p.closed    닫힌 지표(CLOSED_METRICS)
 */
export function buildAudit({ app, cols, checks, review, closed }) {
  const rows = [];
  for (const col of cols) {
    const a = app[col];
    if (!a) continue;
    const date = a.date ?? "";
    const isLtm = col === "LTM";
    for (const m of AUDIT_METRICS) {
      const isClosed = closed.includes(m);
      const appV = num(a[m]);
      const rel = checks.filter((c) => c.col === col && about(c, m));
      // SEC 원자료 — A층 원자료 대조 행(vsSource 값 기록분)만. 배수는 원자료가 없다
      const aRows = MULTIPLES.has(m) ? [] : rel.filter((c) => c.layer === "A" && / 앱 = |^20-F LTM /.test(c.name));
      const aRow = aRows.find((c) => num(c.src) != null) ?? aRows[0] ?? null;
      const sec = aRow ? num(aRow.src) : null;
      const extName = !EXT_ITEM[m] || (isLtm && !EXT_LTM.has(m)) ? null : `${col} ${EXT_ITEM[m]}`;
      const ext = extName ? review.find((x) => x.item === extName) ?? null : null;
      const vals = { yahoo: null, sa: null, infomax: null };
      for (const [n, v] of Object.entries(ext?.sources ?? {})) if (SRC_KEY[n]) vals[SRC_KEY[n]] = num(v);
      const basis = FLOW.has(m) ? `${isLtm ? "TTM" : "FY"} ${date}`.trim() : isLtm ? `현재가 · 재무 ${date}`.trim() : `결산일 ${date}`.trim();

      let verdict, note;
      const fails = rel.filter((c) => c.status === "fail");
      const names = Object.keys(ext?.sources ?? {});
      const unmatched = names.filter((n) => !(ext.matched ?? []).includes(n));
      const passedA = aRow?.status === "pass";
      if (fails.length) {
        verdict = "③";
        note = `${fails[0].layer}층 ${fails[0].name}${fails[0].note ? `: ${fails[0].note}` : ""}${fails.length > 1 ? ` 외 ${fails.length - 1}건` : ""}`;
      } else if (ext?.revenueClass) {
        // 매출 — 검증기 분류(revenue.md §0) 그대로. 외부 단독 이탈은 앱 = SEC 본표 확인 뒤의 외부 소스 쪽 차이라 ② 로 두고 사유에 적는다
        const cls = ext.revenueClass;
        const of = (k) => Object.keys(cls).filter((n) => cls[n] === k);
        if (of("③").length) { verdict = "③"; note = `미규명 차이: ${of("③").map((n) => `${n} ${ext.causes?.[n] ?? "분해식 없음"}`).join("; ")}`; }
        else if (of("②").length || of("외부단독이탈").length) {
          verdict = "②";
          note = [...of("②").map((n) => `${n}: ${ext.causes?.[n] ?? ""}`), ...of("외부단독이탈").map((n) => `${n}: 외부 단독 이탈${ext.causes?.[n] ? ` — ${ext.causes[n]}` : ""}`)].join("; ");
        } else { verdict = "①"; note = `${names.length}곳 일치${passedA ? " · 앱 = SEC" : ""}`; }
      } else if (unmatched.length) {
        const explained = new Set([...(ext.explained ?? []), ...(ext.outliers ?? [])]);
        if (unmatched.every((n) => explained.has(n))) {
          verdict = "②";
          note = unmatched.map((n) => `${n}: ${ext.causes?.[n] ?? "원인 확인"}`).join("; ");
        } else {
          verdict = isClosed ? "③" : "미결";
          const gap = (n) => (ext.ours != null && ext.sources[n] ? ` 차 ${(((ext.ours - ext.sources[n]) / Math.abs(ext.sources[n])) * 100).toFixed(2)}%` : "");
          note = `원인 미규명: ${unmatched.filter((n) => !explained.has(n)).map((n) => `${n}${gap(n)}${ext.causes?.[n] ? ` (${ext.causes[n]})` : ext.definitionDiffs?.[n] ? ` (${ext.definitionDiffs[n]})` : ""}`).join(", ")}`;
        }
      } else if (names.length) {
        verdict = "①"; note = `${names.length}곳 일치${passedA ? " · 앱 = SEC" : ""}`;
      } else if (passedA) {
        verdict = "①"; note = "앱 = SEC 원자료(외부 대조값 없음)";
      } else {
        verdict = "NA";
        const passC = rel.filter((c) => c.status === "pass").length;
        note = appV == null ? "앱 값 없음" : `원자료·외부 대조값 없음${passC ? ` (화면 간·항등식 ${passC}건 통과)` : ""}`;
        if (aRow?.status === "unverifiable" && aRow.note) note += ` · ${aRow.note}`;
      }
      rows.push({ metric: m, period: col, basis, app: appV, sec, ...vals, verdict, note: clip(note), closed: isClosed });
    }
  }
  return rows;
}
