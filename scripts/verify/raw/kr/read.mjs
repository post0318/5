/**
 * 한국 판독(설계 10 §5.2 R-KR1·R-KR2·R-KR3·R-KR4) — DART 원본 → Filing·RawFact.
 *  - 정기공시 목록(list.json) → (사업연도, 보고서 코드)별 최신 접수번호(판본). 보고서명의 대상 연월로 고른다(이듬해 목록에 섞인 지난 연도 정정본).
 *  - fnlttSinglAcntAll 의 행·열을 각각 RawFact 로(당기·전기·전전기, 3개월·누적). 같은 기간이 여러 보고서에 실리면 전부 — 판본 표시만.
 *  - 연결(CFS) 우선, 그 해 CFS 가 013(목록에 보고서 있음)이면 별도(OFS) + no_consolidated. 조회 실패면 별도로 넘어가지 않는다.
 * 앱 데이터 파일(corpcodes.json)을 쓰지 않는다 — 종목 → corp_code 는 DART corpCode.xml 에서(C11).
 */
import { unzipEntries } from "../common/format.mjs";
import { fyKey, monthsBetween, normNum, rawFact } from "../common/rawfact.mjs";

const RE_NM = /(사업|반기|분기)보고서\s*\((\d{4})\.(\d{2})\)/;
const CODE = { annual: "11011", h1: "11012", q1: "11013", q3: "11014" };

/** corpCode.xml → Map(종목코드 6자리 → { corp, name }) */
export async function corpMap(dart) {
  const r = await dart.corpCodes();
  const xml = unzipEntries(r.buf).find((e) => e.name === "CORPCODE.xml").data.toString("utf8");
  const m = new Map();
  for (const x of xml.matchAll(/<list>([\s\S]*?)<\/list>/g)) {
    const b = x[1];
    const stock = /<stock_code>\s*(\d{6})\s*</.exec(b)?.[1];
    if (!stock) continue;
    m.set(stock, { corp: /<corp_code>(\d{8})</.exec(b)[1], name: /<corp_name>([^<]*)</.exec(b)?.[1]?.trim() ?? null });
  }
  return { map: m, version: r.version };
}

/**
 * 정기공시 목록 → 보고서 판본 표
 * @returns {{reports: Array<{year:number, code:string, month:number, latest:string, all:string[], names:string[]}>, fyEndMonth:number|null, rows:any[]}}
 */
export async function reportIndex(dart, corp, { fromYear }) {
  const rows = [];
  for (let page = 1; page <= 20; page++) {
    const r = await dart.listPage(corp, fromYear, page, "A");
    if (r.json.status === "013") break;
    rows.push(...(r.json.list ?? []));
    if (page >= Number(r.json.total_page ?? 1)) break;
  }
  const parsed = [];
  for (const x of rows) {
    const m = RE_NM.exec(x.report_nm ?? "");
    if (!m) continue;
    parsed.push({ kind: m[1], ym: [Number(m[2]), Number(m[3])], rcept: x.rcept_no, name: x.report_nm, dt: x.rcept_dt, amended: /정정|첨부/.test(x.report_nm) });
  }
  // 결산월 = 사업보고서 월의 최빈값
  const cnt = new Map();
  for (const p of parsed) if (p.kind === "사업") cnt.set(p.ym[1], (cnt.get(p.ym[1]) ?? 0) + 1);
  const fyEndMonth = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const by = new Map();
  for (const p of parsed) {
    let code;
    if (p.kind === "사업") code = CODE.annual;
    else if (p.kind === "반기") code = CODE.h1;
    else {
      const off = fyEndMonth == null ? null : (p.ym[1] - fyEndMonth + 12) % 12;
      code = off === 3 ? CODE.q1 : off === 9 ? CODE.q3 : null;
      if (!code) continue;
    }
    // 사업연도 = 대상 연월의 연도(12월 결산). 12월이 아닌 결산은 DART bsns_year 규칙 미확인 — 표시(R-KR1 확인 필요)
    const year = p.ym[0];
    const k = `${year}|${code}`;
    if (!by.has(k)) by.set(k, { year, code, month: p.ym[1], all: [], names: [], amended: false });
    const e = by.get(k);
    e.all.push(p.rcept);
    e.names.push(p.name);
    if (p.amended) e.amended = true;
  }
  const reports = [...by.values()].map((e) => ({ ...e, all: [...e.all].sort(), latest: [...e.all].sort().at(-1), nonDecFy: fyEndMonth !== 12 }));
  reports.sort((a, b) => a.year - b.year || a.code.localeCompare(b.code));
  return { reports, fyEndMonth, rowsCount: rows.length };
}

const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
const nextDay = (iso) => new Date(Date.parse(`${iso}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);

/** 보고서 하나의 기간들 — 사업연도 시작·끝, 그 보고서의 기간 끝·3개월 시작·누적 시작 */
export function reportPeriods(year, code, fyEndMonth = 12) {
  const fyEnd = lastDay(year, fyEndMonth);
  const fyStart = nextDay(lastDay(year - 1, fyEndMonth));
  const qm = { [CODE.q1]: 3, [CODE.h1]: 6, [CODE.q3]: 9, [CODE.annual]: 12 }[code];
  const monthAt = (k) => {
    let m = Number(fyStart.slice(5, 7)) + k, y = Number(fyStart.slice(0, 4));
    while (m > 12) { m -= 12; y++; }
    return [y, m];
  };
  const [ey, em] = monthAt(qm - 1);
  const [sy, sm] = monthAt(qm - 3);
  return { fyStart, fyEnd, qEnd: lastDay(ey, em), qStart: `${sy}-${String(sm).padStart(2, "0")}-01`, cumStart: fyStart, months: qm };
}
const shiftYear = (iso, k) => {
  const y = Number(iso.slice(0, 4)) + k;
  const mmdd = iso.slice(5);
  return mmdd === "02-29" || mmdd === "02-28" ? lastDay(y, 2) : `${y}-${mmdd}`;
};

const STMT = { BS: "bs", IS: "is", CIS: "ci", CF: "cf", SCE: "eq" };
function attributionOf(id, nm) {
  if (/AttributableToNoncontrollingInterests|NoncontrollingInterests/.test(id) || /비지배/.test(nm)) return "nci";
  if (/AttributableToOwnersOfParent|EquityAttributableToOwnersOfParent/.test(id) || /지배기업|지배주주/.test(nm)) return "parent";
  return "none";
}
function opsOf(id, nm) {
  if (/Discontinued/.test(id) || /중단/.test(nm)) return "discontinued";
  if (/Continuing/.test(id) || /계속/.test(nm)) return "continuing";
  return "none";
}

/**
 * fnltt 응답 하나 → RawFact[]
 * @param {object} j 응답 JSON(status 000)
 * @param {{sym, corp, year, code, fs, rcept(판본), fyEndMonth, fetch}} o
 */
export function fnlttFacts(j, o) {
  const out = [];
  if (j.status !== "000") return out;
  const P = reportPeriods(o.year, o.code, o.fyEndMonth ?? 12);
  const annual = o.code === CODE.annual;
  for (const r of j.list ?? []) {
    const stmt = STMT[r.sj_div] ?? null;
    const isFlow = stmt === "is" || stmt === "ci" || stmt === "cf" || stmt === "eq";
    const cols = [];
    if (annual) {
      cols.push(["thstrm_amount", 0, "당기"], ["frmtrm_amount", -1, "전기"], ["bfefrmtrm_amount", -2, "전전기"]);
    } else if (stmt === "bs") {
      cols.push(["thstrm_amount", "q", "당기말"], ["frmtrm_amount", "fyPrev", "전기말"]);
    } else if (stmt === "cf" || stmt === "eq") {
      cols.push(["thstrm_amount", "cum", "당기 누적"], ["frmtrm_amount", "cumPrev", "전기 누적"], ["frmtrm_q_amount", "cumPrev", "전기 누적(q)"], ["frmtrm_add_amount", "cumPrev", "전기 누적(add)"]);
    } else {
      cols.push(["thstrm_amount", "3m", "당기 3개월"], ["thstrm_add_amount", "cum", "당기 누적"], ["frmtrm_q_amount", "3mPrev", "전기 3개월"], ["frmtrm_amount", "3mPrev", "전기 3개월(amount)"], ["frmtrm_add_amount", "cumPrev", "전기 누적"]);
    }
    const seen = new Set();
    for (const [field, which, colName] of cols) {
      if (!(field in r)) continue;
      const raw = r[field];
      const num = normNum(raw);
      let start = null, end;
      if (annual) {
        end = shiftYear(P.fyEnd, which);
        if (isFlow) start = shiftYear(P.fyStart, which);
      } else if (which === "q") end = P.qEnd;
      else if (which === "fyPrev") end = shiftYear(P.fyEnd, -1);
      else if (which === "cum") { start = P.cumStart; end = P.qEnd; }
      else if (which === "cumPrev") { start = shiftYear(P.cumStart, -1); end = shiftYear(P.qEnd, -1); }
      else if (which === "3m") { start = P.qStart; end = P.qEnd; }
      else if (which === "3mPrev") { start = shiftYear(P.qStart, -1); end = shiftYear(P.qEnd, -1); }
      if (!isFlow) start = null;
      const k = `${start}|${end}`;
      if (seen.has(k) && num == null) continue;
      seen.add(k);
      out.push(rawFact({
        market: "kr",
        entity: { sym: o.sym, corp: o.corp },
        filing: { id: o.rcept, form: o.code, filed_at: null, period_end: P.qEnd, amends: null, data_rcept: r.rcept_no ?? null },
        concept: { id: r.account_id, label: r.account_nm, standard: !/표준계정코드\s*미사용/.test(r.account_id), detail: r.account_detail && r.account_detail !== "-" ? r.account_detail : null },
        placement: { face: true, stmts: [{ stmt, sj_nm: r.sj_nm, order: Number(r.ord), section: null }] },
        period: { kind: start ? "duration" : "instant", start, end, months: start ? monthsBetween(start, end) : null, fy_key: fyKey("kr", end), fp: o.code, column: colName, column_label: r[{ thstrm_amount: "thstrm_nm", thstrm_add_amount: "thstrm_nm", frmtrm_amount: "frmtrm_nm", frmtrm_q_amount: "frmtrm_q_nm", frmtrm_add_amount: "frmtrm_nm", bfefrmtrm_amount: "bfefrmtrm_nm" }[field]] ?? null },
        scope: { consolidation: o.fs === "CFS" ? "consolidated" : "separate", attribution: attributionOf(r.account_id, r.account_nm), ops: opsOf(r.account_id, r.account_nm), dims: r.account_detail && r.account_detail !== "-" ? [{ axis: "account_detail", member: r.account_detail }] : [] },
        value: { raw: raw ?? null, num, unit: r.currency ?? "KRW", decimals: null, sign: null, nil: raw == null || String(raw).trim() === "" || /^-$/.test(String(raw).trim()) },
        locator: { source: "fnltt", rcept: o.rcept, reprt_code: o.code, fs_div: o.fs, sj_div: r.sj_div, account_id: r.account_id, account_nm: r.account_nm, ord: r.ord, field },
        fetch: o.fetch,
      }));
    }
  }
  return out;
}

/** 판본 표시 — 같은 (계정·범위·기간)을 보고서 순(접수번호)으로: 처음 공시 = 그 기간 자기 보고서 당기, 최신 = 가장 나중 보고서 */
export function markVintage(facts) {
  const g = new Map();
  for (const f of facts) {
    if (f.value.num == null) continue;
    const k = `${f.concept.id}|${f.concept.label}|${f.scope.consolidation}|${f.concept.detail ?? ""}|${f.period.start ?? ""}|${f.period.end}`;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(f);
  }
  for (const arr of g.values()) {
    arr.sort((a, b) => a.filing.id.localeCompare(b.filing.id));
    const first = arr[0];
    for (const f of arr) {
      f.vintage = { is_original: f === first, is_latest: f === arr[arr.length - 1], restated: f === first ? "same" : f.value.num === first.value.num ? "same" : "different", first_value: first.value.num, versions: arr.length };
    }
  }
  return facts;
}
