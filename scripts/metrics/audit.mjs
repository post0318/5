// 관리자 검증 화면(/admin/verify)의 종목별 감사표 — 오너 결정 2026-09-26.
//
// 지표 14개(매출원가·매출총이익 2026-09-26 추가 — 지표 미종결이라 흐리게) × (최근 사업연도 열 · LTM) 한 줄씩, 앱 값과 SEC 원자료·Yahoo·StockAnalysis·인포맥스 값을 나란히 두고 판정한다.
// 검증기(scripts/verify-financials.mjs)가 이미 계산한 값만 옮긴다 — 새 외부 조회 없음. 정의가 다른 값으로 칸을 채우지 않는다
// (그 칸은 null — 예: LTM 시가총액 칸에 인포맥스 "현재 주식수" 를 쓰지 않는다, 인포맥스 EV(현금 미차감)는 대조 제외).
//
// 판정: ① 일치(앱 값 = 외부 값 완전 일치 — 허용 오차 없음, 오너 지시 2026-09-26) · ② 정의 차이(원인이 숫자로 확인됨 — 사유를 note 에) ·
//      ③ 오류(검사 실패, 닫힌 지표의 미규명 차이) · SEC(SEC 원자료 대조만 통과 · 외부 대조값 없음) ·
//      COMMON 공통모드 — 독립 검증 아님(앱과 같은 규칙·데이터로 판정한 통과·일치·원인만 있음 — ①·②·SEC 로 세지 않는다, 오너 결정 2026-09-26) ·
//      NA 대조값 없음 또는 검증불가(외부 정밀도 부족 — 외부 표기 단위 반올림 round(앱, 단위) = 외부 만으로 설명되는 차이, 오너 결정 2026-09-26) ·
//      미결(닫히지 않은 지표의 원인 미규명 차이). 매출은 검증기의 revenueClass 를 그대로 따른다.
// 순수 함수 — 검증 결과 JSON 으로 따로 시험할 수 있게 검증기 밖에 둔다.

export const AUDIT_METRICS = ["매출", "매출원가", "매출총이익", "영업이익", "순이익", "EPS", "BPS", "시가총액", "EV", "EBITDA", "PER", "PBR", "PSR", "EV/EBITDA"];
/** SEC 원자료 칸을 두지 않는 지표 — 배수는 원자료가 없다 */
const MULTIPLES = new Set(["PER", "PBR", "PSR", "EV/EBITDA"]);
/** 흐름(기간) 지표 — 기준 표기가 FY/TTM. 나머지는 시점(결산일·현재가) */
const FLOW = new Set(["매출", "매출원가", "매출총이익", "영업이익", "순이익", "EPS", "EBITDA"]);
/** 외부 대조(F층) 항목 이름 — 열 이름 뒤에 붙는 부분. LTM 은 검증기가 따로 만드는 이름만 */
const EXT_ITEM = { 매출: "매출", 매출원가: "매출원가", 매출총이익: "매출총이익", 영업이익: "영업이익", 순이익: "순이익", EBITDA: "EBITDA", EPS: "희석 EPS", 시가총액: "시가총액(결산일)" };
const EXT_LTM = new Set(["매출", "매출원가", "매출총이익", "영업이익", "순이익", "EBITDA"]);
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

export const COMMON_VERDICT = "COMMON";
export const COMMON_LABEL = "공통모드 — 독립 검증 아님";

/**
 * 검사 행이 앱과 같은 규칙·데이터로 판정되는가(공통모드) — 그렇다면 사유, 아니면 null. 통과(PASS) 행에만 쓴다.
 * 검증기(scripts/verify-financials.mjs)가 이 사유가 있는 통과를 외부 소스 정확 일치(extItemOf)가 없으면 COMMON 으로 바꾼다.
 * 목록(감사 2026-09-26): 20-F 환산 환율·ADR 비율, 20-F LTM·FY 차입금 재계산, 결산일 주식수(후보 순서)·시가총액(Yahoo 종가·분할 되돌림),
 * 감가상각비(줄 선택 정규식), 매출원가·매출총이익 본표 판독(identifyCogs 와 같은 알고리즘), Q4 = 사업연도 − 9개월·LTM 식,
 * 판본·반올림 재태깅 선택, 환율 곱, 그 밖에 검사 메모에 "공통모드"가 적힌 행(비영업 분리·은행 순수익 합성 등)
 * @param {{ layer: string, name: string, col: string, note?: string }} c
 */
export function commonModeOf(c) {
  const n = c.name, note = c.note ?? "";
  if (/환산 환율 = 기간 평균/.test(n)) return "20-F 환산 환율 — 앱과 같은 원통화 공시값·Yahoo 일별 환율(EPS 는 ADR 비율 = dei ÷ 인포맥스 주식수까지 같음)";
  if (/^20-F /.test(n)) return "20-F 앱 규칙 재구현(Yahoo 원천·Yahoo 환율 공통)";
  if (/^결산일 주식수 /.test(n)) return "결산일 주식수 후보 순서·1.2배 검사 = 앱과 같은 규칙";
  if (/^결산일 시가총액 /.test(n)) return "Yahoo 부동소수 종가·분할 되돌림·주식수 후보 순서 = 앱과 같은 데이터·규칙";
  if (/^감가상각비 앱 = SEC 현금흐름표/.test(n)) return "현금흐름표 감가상각 줄 선택 규칙 = 앱과 같은 규칙";
  if (c.layer === "A" && /매출원가|매출총이익/.test(n)) return "본표 원가 판독 = 앱 identifyCogs 와 같은 알고리즘";
  if (/Q4 = 사업연도 − 9개월/.test(n) || (c.layer === "A" && /당기 ?누적|− 9개월/.test(note))) return "Q4·LTM 식(사업연도 − 9개월 / 사업연도 + 당기 누적 − 전년 동기) = 앱과 같은 식";
  if (c.layer === "A" && /반올림 재태깅 제외/.test(note)) return "판본·반올림 재태깅 선택 = 앱과 같은 규칙";
  if (/(기간|분기) 평균 환율|기말 환율/.test(note)) return "환산 환율 = 앱과 같은 Yahoo 일별 환율";
  // 메모에 공통모드가 적혀 있어도 검사 안에서 이미 독립 확인(회사 태깅 줄·Yahoo 완전 일치 — 비영업 분리 매출)을 거친 행은 제외
  if (/공통모드(?! 아님)/.test(note) && !/독립 확인|Yahoo -?\d+ 완전 일치/.test(note)) return "검사 메모 공통모드(앱 규칙 재구현)";
  return null;
}

/**
 * 공통모드 검사 행을 독립 확인할 외부 대조 항목 — { item: "2025Y 매출" } · { quarter: true, metric } · null(대응 외부 값 없음 → 항상 COMMON).
 * 시가총액·결산일 주식수는 "시가총액(결산일)" 외부 값(= 주식수 × 종가)으로만 확인한다
 */
export function extItemOf(c) {
  if (c.layer !== "A" || /환산 환율|^20-F FY |^첫 열 전년 /.test(c.name)) return null;
  const n = c.name.replace(/^(20-F LTM |20-F |LTM |분기 |결산일 |항등식 미검증 열 )/, "");
  const m = /^매출원가/.test(n) ? "매출원가" : /^매출총이익/.test(n) ? "매출총이익" : /^매출/.test(n) ? "매출" : /^영업이익/.test(n) ? "영업이익"
    : /^순이익/.test(n) ? "순이익" : /^감가상각비/.test(n) ? "감가상각비" : /^(시가총액|주식수)/.test(n) ? "시가총액(결산일)" : null;
  if (!m) return null;
  if (/^\d{4} Q[1-4]$/.test(c.col)) return m === "시가총액(결산일)" ? null : { quarter: true, metric: m };
  if (c.col === "LTM") return m === "시가총액(결산일)" ? null : { item: `LTM ${m}` };
  if (/^\d{4}Y$/.test(c.col)) return { item: `${c.col} ${m}` };
  return null;
}

/**
 * @param {object} p
 * @param {Record<string, {date?: string} & Record<string, number|null>>} p.app  열(예 "2025Y"·"LTM") → 지표 → 앱 값 (+ date)
 * @param {string[]} p.cols      표에 넣을 열 — [최근 사업연도, "LTM"]
 * @param {any[]} p.checks       검증기 검사 행(layer·name·col·status·note·app·src)
 * @param {any[]} p.review       검증기 외부 대조 행(item·ours·sources·matched·explained·outliers·causes·definitionDiffs·revenueClass·metricClass)
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
      const commonA = aRow?.status === "common";
      // 공통모드 소스(일치 또는 원인 규칙이 공통모드) · 외부 정밀도 부족(표기 단위 반올림만) — ①·② 로 세지 않는다
      const cmSrc = ext?.commonMode ?? {}, naSrc = ext?.precisionNa ?? {};
      if (fails.length) {
        verdict = "③";
        note = `${fails[0].layer}층 ${fails[0].name}${fails[0].note ? `: ${fails[0].note}` : ""}${fails.length > 1 ? ` 외 ${fails.length - 1}건` : ""}`;
      } else if (ext?.revenueClass || ext?.metricClass) {
        // 매출(revenueClass)·매출원가·매출총이익(metricClass, --metric=cogs) — 검증기 분류(revenue.md §0) 그대로. 외부 단독 이탈은
        // 앱 = SEC 본표 확인 뒤의 외부 소스 쪽 차이라 ② 로 두고 사유에 적는다
        const cls = ext.revenueClass ?? ext.metricClass;
        const of = (k) => Object.keys(cls).filter((n) => cls[n] === k);
        // 닫히지 않은 지표(매출원가·매출총이익)의 ③ 은 다른 미규명 차이처럼 "미결"로 둔다(닫힌 지표만 ③)
        const extra = [...of("공통모드").map((n) => `${n} 공통모드`), ...of("NA").map((n) => `${n} 외부 정밀도 부족`)].join(", ");
        if (of("③").length) { verdict = isClosed ? "③" : "미결"; note = `미규명 차이: ${of("③").map((n) => `${n} ${ext.causes?.[n] ?? "분해식 없음"}`).join("; ")}`; }
        else if (of("②").length || of("외부단독이탈").length) {
          verdict = "②";
          note = [...of("②").map((n) => `${n}: ${ext.causes?.[n] ?? ""}`), ...of("외부단독이탈").map((n) => `${n}: 외부 단독 이탈${ext.causes?.[n] ? ` — ${ext.causes[n]}` : ""}`), extra].filter(Boolean).join("; ");
        } else if (of("①").length) { verdict = "①"; note = `${of("①").length}곳 일치${passedA ? " · 앱 = SEC" : ""}${extra ? ` · ${extra}` : ""}`; }
        else if (of("공통모드").length) { verdict = COMMON_VERDICT; note = `${COMMON_LABEL}: ${of("공통모드").map((n) => `${n} ${cmSrc[n] ?? ext.causes?.[n] ?? ""}`).join("; ")}`; }
        else { verdict = "NA"; note = `검증불가(외부 정밀도 부족): ${of("NA").map((n) => `${n} ${naSrc[n] ?? ""}`).join("; ")}`; }
      } else if (unmatched.some((n) => !cmSrc[n] && !naSrc[n])) {
        const explained = new Set([...(ext.explained ?? []), ...(ext.outliers ?? [])]);
        const indep = unmatched.filter((n) => !cmSrc[n] && !naSrc[n]);
        if (indep.every((n) => explained.has(n))) {
          verdict = "②";
          note = [...indep.map((n) => `${n}: ${ext.causes?.[n] ?? "원인 확인"}`), ...unmatched.filter((n) => cmSrc[n]).map((n) => `${n} 공통모드`), ...unmatched.filter((n) => naSrc[n]).map((n) => `${n} 외부 정밀도 부족`)].join("; ");
        } else {
          verdict = isClosed ? "③" : "미결";
          const gap = (n) => (ext.ours != null && ext.sources[n] ? ` 차 ${(((ext.ours - ext.sources[n]) / Math.abs(ext.sources[n])) * 100).toFixed(2)}%` : "");
          note = `원인 미규명: ${unmatched.filter((n) => !explained.has(n)).map((n) => `${n}${gap(n)}${ext.causes?.[n] ? ` (${ext.causes[n]})` : ext.definitionDiffs?.[n] ? ` (${ext.definitionDiffs[n]})` : ""}`).join(", ")}`;
        }
      } else if ((ext?.matched ?? []).length) {
        const rest = unmatched.map((n) => `${n} ${cmSrc[n] ? "공통모드" : "외부 정밀도 부족"}`).join(", ");
        verdict = "①"; note = `${ext.matched.length}곳 일치${passedA ? " · 앱 = SEC" : ""}${rest ? ` · ${rest}` : ""}`;
      } else if (unmatched.some((n) => cmSrc[n])) {
        // 외부 값이 있지만 공통모드 소스뿐(현재 주식수 = 인포맥스, 20-F Yahoo 원통화 × 같은 환율, 원인 규칙 ⑥·⑩·R1·R6')
        verdict = COMMON_VERDICT; note = `${COMMON_LABEL}: ${unmatched.filter((n) => cmSrc[n]).map((n) => `${n} ${cmSrc[n]}`).join("; ")}`;
      } else if (unmatched.length) {
        verdict = "NA"; note = `검증불가(외부 정밀도 부족): ${unmatched.map((n) => `${n} ${naSrc[n]}`).join("; ")}`;
      } else if (commonA) {
        verdict = COMMON_VERDICT; note = `${COMMON_LABEL} · SEC 대조가 앱과 같은 규칙 · 외부 정확 일치 없음`;
      } else if (passedA) {
        // 외부 대조값이 하나도 없으면 ①(외부 일치)이 아니다 — SEC 원자료 대조만 된 행은 따로 둔다(오너 지시 2026-09-26, ASML·SPOT·TSM)
        verdict = "SEC"; note = "SEC만 확인 · 외부 없음";
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
