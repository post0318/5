/**
 * 한국 감가상각 원문 판독(설계 10 R-KR11) — 옛 검증기 원문 판독(verify-kr docda.mjs·dart.mjs dartDocDaTables, 감사 3차 「확정 판독만」)을
 * ①로 옮긴 것. 앱 적재 스크립트(populate-kr-da.mjs) 코드는 쓰지 않는다(규칙 문장만 보고 다시 짠 판독 그대로).
 * 바뀐 점: 원문은 공유 보관소 원본 zip 에서(원문 재요청 0), 금액은 부동소수 대신 정수 문자열(BigInt — 원 단위 × 백만원이면 2^53 을 넘는다).
 *  · 표 종류 = 주석 제목 — 성격별(nature)·현금흐름(cf)·투자부동산 변동표(inv)만
 *  · 조합 하나 — (합친 줄 또는 감가) + 사용권(있으면) + 투자부동산(있으면) + 무형(합친 줄이 아니면)
 *  · 열 = 머리행(당기·전기, 3개월·누적), 없으면 표 앞 기간 표시. 같은 기간·누적 열이 여럿이면 값이 있는 마지막 열(합계)
 *  · 범위 = 첨부 종류(00761 연결·00760 별도) → 본문 목차 → 주석 제목의 「연결」
 */
import { unzipEntries } from "../common/format.mjs";
import { BLANK, item } from "../common/rawfact.mjs";

const U = { 원: 0, 천원: 3, 백만원: 6, 억원: 8 };
const txt = (t) => t.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;|&cr;|&amp;/g, " ").replace(/\s+/g, " ").trim();
const units = (t) => [...txt(t).matchAll(/단위\s*:\s*(천원|백만원|억원|원)/g)].map((m) => U[m[1]]);
const lab = (s) => String(s ?? "").replace(/^[\s\-–·ㆍ•\d.)]+/, "").replace(/\(주\s*\d+[^)]*\)/g, "").replace(/\s/g, "");
/** 칸 → BigInt(원표 단위 그대로) 또는 null. 「-」 = 0 */
const num = (c) => {
  const u = String(c ?? "").replace(/\s/g, "");
  if (/^[-–]$/.test(u)) return 0n;
  if (!/^[(△]?-?[\d,]+\)?$/.test(u)) return null;
  const v = BigInt(u.replace(/[(),\-△]/g, ""));
  return /^[(\-△]/.test(u) ? -v : v;
};
const scale = (v, e) => (v == null ? null : v * 10n ** BigInt(e));

/** 원문 zip → 감가상각 줄이 있는 표 [{ unitExp, scope, section, period, rows, file }] */
export function docDaTables(zipBuf) {
  const out = [];
  for (const e of unzipEntries(zipBuf)) {
    let t = new TextDecoder("utf-8").decode(e.data);
    if ((t.match(/�/g) ?? []).length > 50) t = new TextDecoder("euc-kr").decode(e.data);
    const acode = t.match(/<DOCUMENT-NAME[^>]*ACODE="(\d+)"/)?.[1];
    const fileScope = acode === "00761" ? "con" : acode === "00760" ? "sep" : null;
    const titles = [...t.matchAll(/<TITLE[^>]*>([^<]*)<\/TITLE>/g)].map((x) => [x.index, x[1]]);
    const titleScope = (i) => {
      const ti = titles.filter(([k]) => k < i).at(-1)?.[1] ?? "";
      return /연결\s*재무제표/.test(ti) ? "con" : /재무제표/.test(ti) ? "sep" : null;
    };
    const re = /<TABLE[\s\S]*?<\/TABLE>/gi;
    let m, prevEnd = 0, section = null;
    while ((m = re.exec(t))) {
      const tab = m[0];
      const between = txt(t.slice(prevEnd, m.index));
      if ((tab.match(/<TR/gi) ?? []).length >= 3) prevEnd = m.index + tab.length;
      const hs = [...between.matchAll(/(?:^|\s)(\d{1,2})\.\s*([가-힣][^.]{0,30})/g)];
      if (hs.length) section = hs.at(-1)[2].trim();
      if (!/상각/.test(tab)) continue;
      const rows = [...tab.matchAll(/<TR[\s\S]*?<\/TR>/gi)].map((x) => [...x[0].matchAll(/<T([DHEU])([^>]*)>([\s\S]*?)<\/T[DHEU]>/gi)].flatMap((c) => {
        const span = Number(c[2].match(/COLSPAN="?(\d+)/i)?.[1] ?? 1);
        return Array(Math.min(Math.max(span, 1), 20)).fill(txt(c[3]));
      }));
      if (!rows.some((row) => /상각/.test(row[0] ?? ""))) continue;
      const before = t.slice(Math.max(0, m.index - 1500), m.index);
      const unitExp = units(tab.slice(0, 2000))[0] ?? units(before).at(-1) ?? null;
      const tail = between.slice(-40).replace(/\s+/g, "");
      const period = /(당|금)(반기|분기|기)(말)?\)?(\(단위[^)]*\))?$/.test(tail) ? "cur" : /전(반기|분기|기)(말)?\)?(\(단위[^)]*\))?$/.test(tail) ? "prior" : null;
      const secScope = section ? (/연결/.test(section) ? "con" : "sep") : null;
      out.push({ unitExp, scope: fileScope ?? titleScope(m.index) ?? secScope, section, period, rows, file: e.name, pos: m.index });
    }
  }
  return out;
}

function kindOf(l) {
  const paren = l.match(/\((.*?)\)/)?.[1] ?? "";
  if (l.replace(/\(.*?\)/g, "") === "감가상각비" && paren) {
    if (/유,?무형|유형.*무형/.test(paren)) return "comb";
    if (/무형/.test(paren)) return "amo";
    if (/투자부동산/.test(paren)) return "inv";
    if (/사용권/.test(paren)) return "rou";
    if (/유형/.test(paren)) return "dep";
  }
  if (/^(감가상각비(및|와|,)무형자산(감가)?상각(비)?|감가상각비및상각비|유·?무형자산상각비|유형및무형자산상각비)$/.test(l)) return "comb";
  if (/^감가상각비,유형자산$/.test(l)) return "dep";
  if (/^감가상각비,투자부동산$/.test(l)) return "inv";
  if (/^감가상각비,사용권자산$/.test(l)) return "rou";
  if (/^(기타)?상각비,영업권이외의무형자산$/.test(l)) return "amo";
  if (/사용권자산/.test(l) && /상각/.test(l)) return "rou";
  if (/투자부동산/.test(l) && /상각/.test(l)) return "inv";
  if (/^무형자산(감가)?상각비$/.test(l)) return "amo";
  if (/^(유형자산)?감가상각비$|^유형자산상각비$/.test(l)) return "dep";
  return null;
}
export function tableKind(t) {
  const s = t.section ?? "";
  if (/성격별/.test(s)) return "nature";
  if (/투자부동산/.test(s)) return "inv";
  if (/현금흐름|영업으로부터\s*창출|영업활동/.test(s)) return "cf";
  return null;
}
function columns(t, width) {
  const isData = (r) => r.slice(1).some((c) => num(c) != null && String(c).trim() !== "-");
  const first = t.rows.findIndex(isData);
  const hdrs = (first < 0 ? [] : t.rows.slice(0, first)).filter((r) => r.slice(1).some((c) => String(c).trim()));
  const cols = [];
  for (let j = 0; j < width; j++) {
    let period = null, cum = null;
    for (const h of hdrs) {
      const off = h.length - 1 - width;
      if (off < 0) continue;
      const l = String(h[1 + off + j] ?? "").replace(/\s/g, "");
      if (/^(당|금)(반기|분기|기)|\(당\)/.test(l)) period = "cur";
      else if (/^전(반기|분기|기)|\(전\)/.test(l)) period = "prior";
      if (/누적/.test(l)) cum = true;
      else if (/3개월/.test(l)) cum = false;
    }
    cols.push({ period: period ?? t.period ?? null, cum });
  }
  return cols;
}

/** 표 목록 → 확정 후보 [{ v, vNoInv, comps, scope, kind, period, cum, sig, how }] — 금액은 원 단위 정수 문자열 */
export function daCandidates(tables) {
  const out = [];
  tables.forEach((t, ti) => {
    const kind = tableKind(t);
    if (t.unitExp == null || (kind !== "nature" && kind !== "cf")) return;
    const segs = [];
    let cur = null;
    for (const r of t.rows) {
      const k = kindOf(lab(r[0]));
      if (!k) continue;
      if (!cur || (k in cur && (k === "dep" || k === "comb"))) { cur = {}; segs.push(cur); }
      if (!(k in cur)) cur[k] = r.slice(1).map(num);
    }
    segs.forEach((s, si) => {
      const cols = columns(t, (s.comb ?? s.dep ?? []).length);
      const has = (j) => { const b = s.comb?.[j] ?? s.dep?.[j] ?? null; return b != null && b !== 0n; };
      for (let j = 0; j < cols.length; j++) {
        if (!has(j) || cols.some((d, k) => k > j && has(k) && d.period === cols[j].period && d.cum === cols[j].cum)) continue;
        const g = (k) => s[k]?.[j] ?? null;
        const base = g("comb") ?? g("dep");
        const rou = g("rou"), inv = g("inv"), amo = g("comb") != null ? null : g("amo");
        const sig = [g("comb") != null ? "comb" : "dep", rou != null && "rou", inv != null && "inv", amo != null && "amo"].filter(Boolean).join("+");
        const v = base + (rou ?? 0n) + (inv ?? 0n) + (amo ?? 0n);
        const S = (x) => (x == null ? null : String(scale(x, t.unitExp)));
        out.push({
          v: S(v), vNoInv: inv != null ? S(v - inv) : null, comps: { rou: S(rou), inv: S(inv), amo: S(amo) },
          scope: t.scope ?? null, kind, period: cols[j].period, cum: cols[j].cum, sig, unitExp: t.unitExp, file: t.file, pos: t.pos,
          how: `표${ti + 1}[${t.section ?? "?"}${t.scope ? `·${t.scope === "con" ? "연결" : "별도"}` : ""}]·묶음${si + 1}·열${j + 1}(${cols[j].period ?? "?"}${cols[j].cum === true ? "·누적" : cols[j].cum === false ? "·3개월" : ""}) ${sig}`,
        });
      }
    });
  });
  return out;
}

/** 투자부동산 변동표의 감가상각(마지막 숫자 열 절댓값) */
export function invTableDep(tables) {
  const out = [];
  tables.forEach((t, ti) => {
    if (t.unitExp == null || tableKind(t) !== "inv") return;
    for (const r of t.rows) {
      if (!/^감가상각(비)?$/.test(lab(r[0]))) continue;
      const vs = r.slice(1).map(num).filter((x) => x != null && x !== 0n);
      if (vs.length) {
        const a = vs.at(-1) < 0n ? -vs.at(-1) : vs.at(-1);
        out.push({ v: String(scale(a, t.unitExp)), scope: t.scope ?? null, period: t.period ?? null, how: `표${ti + 1}[${t.section}] 투자부동산 감가상각` });
      }
    }
  });
  return out;
}

/** 보고서 하나(사업·반기·분기)의 감가상각 원문 후보 → Item(da_doc_candidate) — 어느 후보를 쓸지는 ④(K3 규칙) */
export function daDocItems(zipBuf, { rcept, year, code }) {
  const tables = docDaTables(zipBuf);
  const cands = daCandidates(tables);
  const inv = invTableDep(tables);
  const out = [];
  const per = (which) => {
    const y = which === "prior" ? year - 1 : year;
    return { kind: "duration", start: `${y}-01-01`, end: code === "11011" ? `${y}-12-31` : null, months: null, fy_key: y, fp: code, column: which ?? "?" };
  };
  for (const c of cands) {
    out.push(item({
      key: c.kind === "nature" ? "da_doc_nature" : "da_doc_cf", period: per(c.period), value: c.v, facts: [`doc|${rcept}|${c.file}|${c.pos}`],
      rule: { id: "R-KR11", how: c.how, sig: c.sig, cum: c.cum, scope: c.scope }, vintage_basis: { filing: rcept, form: code },
      flags: { v_without_investment_property: c.vNoInv, comps: c.comps, period_unknown: c.period == null, scope_unknown: c.scope == null },
    }));
  }
  for (const c of inv) {
    out.push(item({ key: "da_doc_investment_property", period: per(c.period), value: c.v, facts: [`doc|${rcept}`], rule: { id: "R-KR11", how: c.how, scope: c.scope }, vintage_basis: { filing: rcept, form: code } }));
  }
  if (!cands.length && !inv.length) {
    out.push(item({ key: "da_doc_nature", period: per("cur"), value: null, blank_reason: BLANK.confirmed_absent, blank_detail: { why: "감가상각 줄이 든 성격별·현금흐름 주석 표 없음", tables: tables.length }, rule: { id: "R-KR11" }, vintage_basis: { filing: rcept, form: code } }));
  }
  return out;
}
