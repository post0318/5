// 관리자 검증 화면(/admin/verify)의 종목별 감사표 — 오너 결정 2026-09-26.
//
// 지표 15개(매출원가·매출총이익 2026-09-26 추가, 감가상각비 2026-09-27 추가 — 지표 미종결이라 흐리게) × (최근 사업연도 열 · LTM) 한 줄씩, 앱 값과 SEC 원자료·Yahoo·StockAnalysis·인포맥스 값을 나란히 두고 판정한다.
// 검증기(scripts/verify-financials.mjs)가 이미 계산한 값만 옮긴다 — 새 외부 조회 없음. 정의가 다른 값으로 칸을 채우지 않는다
// (그 칸은 null — 예: LTM 시가총액 칸에 인포맥스 "현재 주식수" 를 쓰지 않는다, 인포맥스 EV(현금 미차감)는 대조 제외).
//
// 판정: ① 일치(앱 값 = 외부 값 완전 일치 — 허용 오차 없음, 오너 지시 2026-09-26) · ② 정의 차이(원인이 숫자로 확인됨 — 사유를 note 에) ·
//      ③ 오류(검사 실패, 닫힌 지표의 미규명 차이) · SEC(SEC 원자료 대조만 통과 · 외부 대조값 없음) ·
//      COMMON 공통모드 — 독립 검증 아님(앱과 같은 규칙·데이터로 판정한 통과·일치·원인만 있음 — ①·②·SEC 로 세지 않는다, 오너 결정 2026-09-26) ·
//      NA 대조값 없음 또는 검증불가(외부 정밀도 부족 — 외부 표기 단위 반올림 round(앱, 단위) = 외부 만으로 설명되는 차이, 오너 결정 2026-09-26) ·
//      미결(닫히지 않은 지표의 원인 미규명 차이). 매출은 검증기의 revenueClass 를 그대로 따른다.
// 순수 함수 — 검증 결과 JSON 으로 따로 시험할 수 있게 검증기 밖에 둔다.

export const AUDIT_METRICS = ["매출", "매출원가", "매출총이익", "영업이익", "감가상각비", "순이익", "EPS", "BPS", "시가총액", "EV", "EBITDA", "PER", "PBR", "PSR", "EV/EBITDA"];
/** SEC 원자료 칸을 두지 않는 지표 — 배수는 원자료가 없다 */
const MULTIPLES = new Set(["PER", "PBR", "PSR", "EV/EBITDA"]);
/** 흐름(기간) 지표 — 기준 표기가 FY/TTM. 나머지는 시점(결산일·현재가) */
const FLOW = new Set(["매출", "매출원가", "매출총이익", "영업이익", "감가상각비", "순이익", "EPS", "EBITDA"]);
/** 외부 대조(F층) 항목 이름 — 열 이름 뒤에 붙는 부분. LTM 은 검증기가 따로 만드는 이름만 */
const EXT_ITEM = { 매출: "매출", 매출원가: "매출원가", 매출총이익: "매출총이익", 영업이익: "영업이익", 감가상각비: "감가상각비", 순이익: "순이익", EBITDA: "EBITDA", EPS: "희석 EPS", 시가총액: "시가총액(결산일)" };
const EXT_LTM = new Set(["매출", "매출원가", "매출총이익", "영업이익", "감가상각비", "순이익", "EBITDA"]);
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
 * 목록(감사 2026-09-26, 환율은 2026-09-27 H.10 전환으로 제외): 20-F ADR 비율, 20-F LTM·FY 차입금 재계산, 결산일 주식수(후보 순서)·시가총액(Yahoo 종가·분할 되돌림),
 * 감가상각비(줄 선택 정규식), 매출원가·매출총이익 본표 판독(identifyCogs 와 같은 알고리즘), Q4 = 사업연도 − 9개월·LTM 식,
 * 판본·반올림 재태깅 선택, 환율 곱, 그 밖에 검사 메모에 "공통모드"가 적힌 행(비영업 분리·은행 순수익 합성 등)
 * @param {{ layer: string, name: string, col: string, note?: string }} c
 */
/** D형 구성 규칙 공통모드 사유 — 이 사유는 외부 1곳 일치로 풀리지 않는다(2곳 이상, 기간별 정확 일치 — handoff 공통모드 목록 5) */
export const COGS_RULE_COMMON = "D형 매출원가 구성 규칙 = 앱과 같은 규칙표(외부 2곳 이상 정확 일치 시만 독립)";

export function commonModeOf(c) {
  const n = c.name, note = c.note ?? "";
  // 20-F 환산 환율 = 연준 H.10 공식 고시(오너 결정 2026-09-27) — 검증기가 FRED 에서 따로 받아 같은 정의로 다시 계산한 값과 정확 대조하므로
  // 환율은 공통모드 사유가 아니다(메모 표식 "환율 H.10 독립 조회", 또는 미고시 창의 빈칸 확인). 다른 사유(ADR 비율·Yahoo 분기 원천·
  // 차입금 규칙 재구현)는 그대로 남는다
  const fxInd = /환율 H\.10 독립 조회|H\.10 공식 환율 미고시/.test(note);
  if (/환산 환율 = 기간 평균/.test(n)) {
    if (/EPS/.test(n)) return "20-F EPS 환산 — ADR 비율 = dei ÷ 인포맥스 주식수(1.5배 규칙)가 앱과 같은 규칙";
    return fxInd ? null : "20-F 환산 환율 — H.10 독립 조회 표식 없음";
  }
  // 6-K 대조(2026-10-02): 6-K 값은 검증기가 따로 판독하지만 LTM 식(사업연도 + 당기 누적 − 전년 동기)이 앱과 같은 식이다
  if (/^20-F LTM .*= SEC 20-F \+ 6-K/.test(n)) return "LTM 식(사업연도 + 당기 누적 − 전년 동기) = 앱과 같은 식 · 6-K 값은 검증기 독립 판독";
  // 6-K 기록 대조(재감사 e-1, 2026-10-02) — 재무상태표 값(bs·bsZero)은 6-K 문서 글자 판독 + SEC 20-F 연말 값 확인 + H.10 기말 환율로 따로 계산(독립).
  // 현금흐름(cf·cfZero)은 LTM 식이 앱과 같고, 변동분 근사(bsDelta)는 결정 (가) 식, 합성(derived)은 앱 합산 규칙이라 공통모드
  if (/^20-F LTM 6-K (bs|bsZero) /.test(n)) return null;
  // 0 규칙(EV 구성요소) — SEC 연말 값만으로 확인(독립)
  if (/^20-F LTM zero /.test(n)) return null;
  // 공란 완결성(앱이 비운 LTM 을 6-K 에서 찾는 검사) — 6-K 글자 판독 + SEC 연말 확인(독립)
  if (/^20-F LTM 공란 /.test(n)) return null;
  if (/^20-F LTM 6-K (cf|cfZero) /.test(n)) return "LTM 식(사업연도 + 당기 누적 − 전년 동기) = 앱과 같은 식 · 6-K 값은 검증기 독립 판독";
  if (/^20-F LTM 6-K bsDelta /.test(n)) return "SEC 연말 + 6-K 변동분 = 앱과 같은 식(결정 (가)) · 6-K 값은 검증기 독립 판독";
  // 사업연도 완결성(재감사 7차) — 기대값 = 검증기가 읽은 SEC 20-F 원본 × 검증기가 받은 H.10(독립). 대응표(IFRS → 앱 개념)만 앱 것을 쓴다
  // 합성 차입금(본표 차입금 + 리스) 기대값은 검증기가 SEC 원본으로 계산하지만 규칙 자체는 앱 차입금 규칙의 재구현 — 공통모드
  if (/^20-F 사업연도 연말 합성 Debt/.test(n)) return "본표 차입금 + 리스 규칙 재구현(앱 차입금 규칙 공통)";
  if (/^20-F (사업연도|대응표) /.test(n)) return null;
  // 원통화 LTM 순이익 블룸버그 = Yahoo 분기 합(2026-10-07) — 블룸버그는 앱이 쓰지 않는 원자료, 환율·앱 규칙 없음(독립). Yahoo 가 앱 원천이어도
  // 블룸버그가 따로 같은 값을 내면 원자료 확인
  if (/^20-F LTM 순이익 원통화 블룸버그/.test(n)) return null;
  if (/^20-F LTM /.test(n)) return "20-F LTM 앱 규칙 재구현(Yahoo 분기 원천 공통)";
  if (/^20-F /.test(n)) return "20-F 앱 규칙 재구현(차입금 규칙 공통)";
  if (/^결산일 주식수 /.test(n)) return "결산일 주식수 후보 순서·1.2배 검사 = 앱과 같은 규칙";
  if (/^결산일 시가총액 /.test(n)) return "Yahoo 부동소수 종가·분할 되돌림·주식수 후보 순서 = 앱과 같은 데이터·규칙";
  if (/^(분기 )?감가상각비 앱 = SEC 현금흐름표/.test(n)) return "현금흐름표 감가상각 줄 선택 규칙 = 앱과 같은 규칙";
  // D형 구성 규칙 행 — 앱과 검증기가 같은 규칙표(src 표 ↔ scripts/metrics/cogs-rules.json)를 쓴다. 외부 2곳 이상 정확 일치일 때만 독립(COGS_RULE_COMMON)
  if (c.layer === "A" && /매출원가|매출총이익/.test(n) && /구성 규칙/.test(note)) return COGS_RULE_COMMON;
  if (c.layer === "A" && /매출원가|매출총이익/.test(n)) return "본표 원가 판독 = 앱 identifyCogs 와 같은 알고리즘";
  // 영업이익 합성(소계 없는 본표) — 표준 개념의 영업외 판정은 FASB 택사노미(독립)지만, 회사 고유 줄의 라벨 판정·총수익 비영업 분리는 앱과 같은
  // 성격의 규칙이다(2026-09-27, --metric=opinc). 판본 decimals 독립 확인 메모가 붙어도 이 사유는 남는다
  if (c.layer === "A" && /^(분기 )?영업이익\(합성\)/.test(n) && /회사 고유 줄 라벨로 영업외 판정|총수익 비영업 분리/.test(note)) return "영업외 판정 — 회사 고유 줄 라벨·총수익 비영업 분리 = 앱과 같은 성격의 규칙";
  if (/Q4 = 사업연도 − 9개월/.test(n) || (c.layer === "A" && /당기 ?누적|− 9개월/.test(note))) return "Q4·LTM 식(사업연도 − 9개월 / 사업연도 + 당기 누적 − 전년 동기) = 앱과 같은 식";
  // 판본 선택이 공시 원본 decimals 로 독립 확인된 행(검증기 applyVintage — "판본 decimals 독립 확인")은 이 사유에서 뺀다(오너 승인 2단계)
  if (c.layer === "A" && /반올림 재태깅 제외/.test(note) && !/판본 decimals 독립 확인|회사 decimals 표기 불일치 — 외부 독립 확인/.test(note)) return "판본·반올림 재태깅 선택 = 앱과 같은 규칙(decimals 근거 없음)";
  if (/(기간|분기) 평균 환율|기말 환율/.test(note) && !fxInd) return "환산 환율 — H.10 독립 조회 표식 없음";
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
  // 판관비·연구개발비(--metric=sga) — 대조 행 본체만(하위 줄·빈칸 행은 외부 값이 없다)
  const m = /^판관비 앱 = /.test(n) ? "판관비" : /^연구개발비 앱 = /.test(n) ? "연구개발비" : /^매출원가/.test(n) ? "매출원가" : /^매출총이익/.test(n) ? "매출총이익" : /^매출/.test(n) ? "매출" : /^영업이익/.test(n) ? "영업이익"
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
      // 검증불가 사유 이름 — 인포맥스 자체 환율(비공개) 규칙이면 "외부 환율 비공개", 그 밖엔 "외부 정밀도 부족"(표기 단위 반올림)
      const naLab = (n) => (/자체 환율\(비공개\)/.test(naSrc[n] ?? "") ? "외부 환율 비공개" : "외부 정밀도 부족");
      if (fails.length) {
        verdict = "③";
        note = `${fails[0].layer}층 ${fails[0].name}${fails[0].note ? `: ${fails[0].note}` : ""}${fails.length > 1 ? ` 외 ${fails.length - 1}건` : ""}`;
      } else if (ext?.revenueClass || ext?.metricClass) {
        // 매출(revenueClass)·매출원가·매출총이익(metricClass, --metric=cogs) — 검증기 분류(revenue.md §0) 그대로. 외부 단독 이탈은
        // 앱 = SEC 본표 확인 뒤의 외부 소스 쪽 차이라 ② 로 두고 사유에 적는다
        const cls = ext.revenueClass ?? ext.metricClass;
        const of = (k) => Object.keys(cls).filter((n) => cls[n] === k);
        // 닫히지 않은 지표(매출원가·매출총이익)의 ③ 은 다른 미규명 차이처럼 "미결"로 둔다(닫힌 지표만 ③)
        const extra = [...of("공통모드").map((n) => `${n} 공통모드`), ...of("NA").map((n) => `${n} ${naLab(n)}`), ...of("외부정의분해불가").map((n) => `${n} 외부 정의 분해 불가`), ...of("구성미분해").map((n) => `${n} 구성 미분해(정의 차이 미확인)`)].join(", ");
        // Yahoo 1순위(오너 결정 2026-09-27 — 멀티플 비교점이 Yahoo): Yahoo 가 ①·② 면 행 판정은 Yahoo 분류, 아니면 다른 소스 ①·② 로 통과
        const yc = cls.Yahoo;
        // 외부 한 곳이라도 ①·② 면 통과(오너 결정) — 나머지 소스의 미규명 차이는 사유에만 적는다(A층 FAIL 은 위 fails 가 먼저 ③)
        const rest3 = of("③").length ? ` · 미규명(외부 확인으로 통과): ${of("③").map((n) => `${n} ${ext.causes?.[n] ?? "분해식 없음"}`).join("; ")}` : "";
        // D형 구성 규칙 행(A층이 앱 규칙 재구현 — 공통모드)은 외부 2곳 이상 정확 일치일 때만 ①(cogs.md §10, 감사 2026-09-28 MEDIUM-1)
        if (commonA && /구성 규칙/.test(aRow?.note ?? "") && of("①").length < 2) { verdict = COMMON_VERDICT; note = `${COMMON_LABEL}: 구성 규칙(D형) — 외부 정확 일치 ${of("①").length}곳(2곳 이상 필요)${extra ? ` · ${extra}` : ""}`; }
        else if (yc === "①") { verdict = "①"; note = `Yahoo 일치${of("①").length > 1 ? `(${of("①").length}곳)` : ""}${passedA ? " · 앱 = SEC" : ""}${of("②").length ? ` · ${of("②").map((n) => `${n} ② ${ext.causes?.[n] ?? ""}`).join("; ")}` : ""}${extra ? ` · ${extra}` : ""}${rest3}`; }
        else if (yc === "②") { verdict = "②"; note = [`Yahoo: ${ext.causes?.Yahoo ?? ""}`, ...of("②").filter((n) => n !== "Yahoo").map((n) => `${n}: ${ext.causes?.[n] ?? ""}`), extra].filter(Boolean).join("; ") + rest3; }
        else if (of("③").length && !of("①").length && !of("②").length && !of("외부단독이탈").length) { verdict = isClosed ? "③" : "미결"; note = `미규명 차이: ${of("③").map((n) => `${n} ${ext.causes?.[n] ?? "분해식 없음"}`).join("; ")}`; }
        else if (of("②").length || of("외부단독이탈").length) {
          verdict = "②";
          note = [...of("②").map((n) => `${n}: ${ext.causes?.[n] ?? ""}`), ...of("외부단독이탈").map((n) => `${n}: 외부 단독 이탈${ext.causes?.[n] ? ` — ${ext.causes[n]}` : ""}`), extra].filter(Boolean).join("; ") + rest3;
        } else if (of("①").length) { verdict = "①"; note = `${of("①").length}곳 일치${passedA ? " · 앱 = SEC" : ""}${extra ? ` · ${extra}` : ""}${rest3}`; }
        else if (of("공통모드").length) { verdict = COMMON_VERDICT; note = `${COMMON_LABEL}: ${of("공통모드").map((n) => `${n} ${cmSrc[n] ?? ext.causes?.[n] ?? ""}`).join("; ")}`; }
        else { verdict = "NA"; note = of("NA").map((n) => `검증불가(${naLab(n)}): ${n} ${naSrc[n] ?? ""}`).join("; "); }
      } else if (unmatched.some((n) => !cmSrc[n] && !naSrc[n])) {
        const explained = new Set([...(ext.explained ?? []), ...(ext.outliers ?? [])]);
        const indep = unmatched.filter((n) => !cmSrc[n] && !naSrc[n]);
        if (indep.every((n) => explained.has(n))) {
          verdict = "②";
          note = [...indep.map((n) => `${n}: ${ext.causes?.[n] ?? "원인 확인"}`), ...unmatched.filter((n) => cmSrc[n]).map((n) => `${n} 공통모드`), ...unmatched.filter((n) => naSrc[n]).map((n) => `${n} ${naLab(n)}`)].join("; ");
        } else {
          verdict = isClosed ? "③" : "미결";
          const gap = (n) => (ext.ours != null && ext.sources[n] ? ` 차 ${(((ext.ours - ext.sources[n]) / Math.abs(ext.sources[n])) * 100).toFixed(2)}%` : "");
          note = `원인 미규명: ${unmatched.filter((n) => !explained.has(n)).map((n) => `${n}${gap(n)}${ext.causes?.[n] ? ` (${ext.causes[n]})` : ext.definitionDiffs?.[n] ? ` (${ext.definitionDiffs[n]})` : ""}`).join(", ")}`;
        }
      } else if ((ext?.matched ?? []).length) {
        const rest = unmatched.map((n) => `${n} ${cmSrc[n] ? "공통모드" : naLab(n)}`).join(", ");
        verdict = "①"; note = `${ext.matched.length}곳 일치${passedA ? " · 앱 = SEC" : ""}${rest ? ` · ${rest}` : ""}`;
      } else if (unmatched.some((n) => cmSrc[n])) {
        // 외부 값이 있지만 공통모드 소스뿐(현재 주식수 = 인포맥스, 원인 규칙 ⑥·⑩·R1·R6')
        verdict = COMMON_VERDICT; note = `${COMMON_LABEL}: ${unmatched.filter((n) => cmSrc[n]).map((n) => `${n} ${cmSrc[n]}`).join("; ")}`;
      } else if (unmatched.length) {
        verdict = "NA"; note = unmatched.map((n) => `검증불가(${naLab(n)}): ${n} ${naSrc[n]}`).join("; ");
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

// ── 판본 판정 — XBRL decimals 기반 독립 판정(오너 승인 2단계, 2026-09-26) ─────────────────────────────────────────────
// 앱(src/lib/fin/read/vintage.ts)과 검증기의 옛 규칙(prepareColumnVintage·precisionRel·RETAG_UNITS)은 "값이 단위 배수인가"로 반올림
// 재게시를 추측한다 — 같은 추측이라 같이 틀린다(공통모드, MRVL 1e5 재태깅을 둘 다 놓쳤다). 여기서는 값의 모양을 보지 않고 공시
// 원본 인스턴스의 decimals 속성(회사가 선언한 정밀도)만 근거로 쓴다.
//
// 규칙: 같은 개념·같은 기간 사실을 공시일 순(같은 공시 안에서는 decimals 큰 것 먼저)으로 훑으며 "현재 기준값" A 를 둔다. 다음 사실 L 이
//   · L 값 = A 값 → 같은 값(A 를 L 로 — decimals 가 같거나 큰 쪽만),
//   · decimals(L) < decimals(A) 이고 L 값 = round(A 값, 10^−decimals(L)) → 정밀도만 낮춘 재게시(A 유지),
//   · 그 밖에 값이 다르면 → 진짜 재작성(A = L). 같은 공시 안에서 재작성이 나오면(한 공시에 한 기간 값 둘) 판정 불가.
// 반올림 정의(명시): 10^−d 의 가장 가까운 배수. 정확히 가운데(끝자리 5 뒤 0)면 두 이웃 모두 인정 — 회사마다 사사오입·짝수 반올림이
//   섞여 있어 가운데 값만 어느 쪽인지 선언이 없다. decimals="INF" 는 정확값(무한 정밀). decimals 가 하나라도 없으면 판정 불가.
/** 값 v(정밀도 dec)를 10^scale 배 정수(BigInt)로 — 소수 자릿수가 scale 을 넘으면 null */
function scaled(v, scale) {
  const s = Math.round(v * 10 ** scale);
  return Math.abs(s - v * 10 ** scale) < 1e-6 * Math.max(1, Math.abs(s)) && Number.isSafeInteger(s) ? BigInt(s) : null;
}
/** later 가 earlier 를 later.dec 자리로 반올림한 값인가(위 반올림 정의) */
export function isDecimalsRounding(earlier, later) {
  if (!(later.dec < earlier.dec)) return false;
  const K = Math.max(0, Number.isFinite(earlier.dec) ? earlier.dec : 6, later.dec);
  if (K > 12) return false;
  const a = scaled(earlier.val, K), b = scaled(later.val, K);
  if (a == null || b == null) return false;
  const q = 10n ** BigInt(K - later.dec);
  const neg = a < 0n, m = neg ? -a : a;
  const lo = (m / q) * q, rem = m - lo;
  const cands = 2n * rem > q ? [lo + q] : 2n * rem < q ? [lo] : [lo, lo + q];
  return cands.some((c) => (neg ? -c : c) === b);
}
/**
 * 선언 정밀도보다 거친 반올림 재게시(2026-09-28 — MCD 2022 순이익: 2023-02-24·2024-02-22 10-K 6,177,400,000(d−5) → 2025-02-25 10-K
 * 6,177,000,000 — 같은 공시 안에서 같은 값을 d−6(본표)·d−5(자본변동표)로 함께 선언. 2023 자산총계 56,146,800,000(d−5) → 2024-05-08 10-Q
 * 56,147,000,000(d−5 만)). 나중 값이 선언 단위(10^−d)보다 큰 10^k(k = 3~10)의 배수이고, 그 단위로 먼저 값을 반올림한 값과 정확히 같으면
 * (위 반올림 정의 — isDecimalsRounding 을 d = −k 로) 실제로는 10^k 단위 반올림 재게시로 본다 → k | null. 작은 값 오판정 방지 — |나중 값| ≥ 100 × 10^k.
 * 한계: 진짜 재작성이 우연히 먼저 값의 반올림값과 정확히 같으면 재게시로 오판한다(선언 decimals 가 그 반올림을 부정하는데도 값 모양을 믿는 규칙)
 */
export function coarseRounding(earlier, later) {
  if (later.val === earlier.val || later.dec == null || !Number.isFinite(later.dec) || earlier.dec == null) return null;
  for (let k = Math.max(3, -later.dec + 1); k <= 10; k++) {
    const u = 10 ** k;
    if (Math.abs(later.val) < 100 * u || later.val % u !== 0) continue;
    if (!(-k < earlier.dec)) continue;
    if (isDecimalsRounding(earlier, { val: later.val, dec: -k })) return k;
  }
  return null;
}
/**
 * @param {{ accn: string, filed: string, val: number, dec: number | null }[]} facts 한 개념·한 기간의 공시별 사실(값이 다른 판본 전부)
 * @returns {{ ok: true, val: number, accn: string, represented: { val: number, accn: string, dec: number, of: number }[], restated: { val: number, accn: string, from: number }[], txt: string }
 *          | { ok: false, why: string }}
 */
export function decimalsVintage(facts) {
  if (!facts.length) return { ok: false, why: "사실 없음" };
  const miss = facts.filter((f) => f.dec == null || Number.isNaN(f.dec));
  if (miss.length) return { ok: false, why: `decimals 없음: ${miss.map((f) => `${f.accn} ${f.val}`).join(", ")}` };
  const order = [...facts].sort((x, y) => (x.filed !== y.filed ? (x.filed < y.filed ? -1 : 1) : x.accn !== y.accn ? (x.accn < y.accn ? -1 : 1) : y.dec - x.dec));
  const decTxt = (d) => (Number.isFinite(d) ? String(d) : "INF");
  let A = order[0];
  const represented = [], restated = [], log = [`${A.filed} ${A.val}(d${decTxt(A.dec)})`];
  for (const L of order.slice(1)) {
    if (L.val === A.val) { if (L.dec >= A.dec) A = L; continue; }
    if (isDecimalsRounding(A, L)) { represented.push({ val: L.val, accn: L.accn, dec: L.dec, of: A.val }); log.push(`${L.filed} ${L.val}(d${decTxt(L.dec)}) = round(${A.val}) 재게시`); continue; }
    const k = coarseRounding(A, L);
    if (k != null) { represented.push({ val: L.val, accn: L.accn, dec: -k, of: A.val, declared: L.dec }); log.push(`${L.filed} ${L.val}(d${decTxt(L.dec)} 선언, 실제 10^${k} 단위) = round(${A.val}, 10^${k}) 재게시`); continue; }
    // 반올림 맞춤(오너 결정 2026-09-28 "원 공시 정밀값으로 통일"): 나중 공시가 더 거친 단위로 다시 실으며 합계를 맞추려 한 줄을 1단위
    // 조정한 경우 — |나중 − 먼저| ≤ 1.5 × 나중 단위(반올림 0.5 + 조정 1). MRVL FY2022 연구개발비 1,424,306,000(d−3) → 1,424,200,000(d−5),
    // 판관비 955,245,000 → 955,300,000 — 두 줄이 0.1백만을 맞바꿔 합 2,379.5 보존. 먼저 값(정밀값)을 유지한다
    if (L.accn !== A.accn && Number.isFinite(L.dec) && A.dec > L.dec && Math.abs(L.val - A.val) <= 1.5 * 10 ** -L.dec) {
      represented.push({ val: L.val, accn: L.accn, dec: L.dec, of: A.val, footing: true });
      log.push(`${L.filed} ${L.val}(d${decTxt(L.dec)}) ≈ ${A.val} 반올림 맞춤(1단위 조정) — 정밀값 유지`);
      continue;
    }
    if (L.accn === A.accn) return { ok: false, why: `같은 공시 ${L.accn} 에 반올림 관계가 아닌 두 값 ${A.val}·${L.val}` };
    restated.push({ val: L.val, accn: L.accn, from: A.val });
    log.push(`${L.filed} ${L.val}(d${decTxt(L.dec)}) 재작성`);
    A = L;
  }
  return { ok: true, val: A.val, accn: A.accn, represented, restated, txt: log.join(" → ") };
}
