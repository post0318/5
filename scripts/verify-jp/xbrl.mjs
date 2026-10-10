/**
 * 일본 검증기 — EDINET XBRL 판독(검증기 독립 구현 — 앱 src/lib/markets/jp/xbrl-fin.ts 를 가져오지 않는다. docs/verify-jp-design.md §3).
 *
 * 개념 열쇠: 표준 "jppfs_cor:NetSales"·"jpigp_cor:RevenueIFRS"·"jpcrp_cor:…", 회사 고유 "ext:로컬이름"(회사 이름공간 URI 에 E#####-### 가 있는 것).
 * 앱 화면의 accountId 도 같은 꼴이라(요소 ID) 계정명이 일본어·한국어로 바뀌어도 대조가 깨지지 않는다.
 *
 * parseDoc(files) →
 *   dei      AccountingStandardsDEI·WhetherConsolidated…·TypeOfCurrentPeriodDEI·CurrentFiscalYearStart/EndDateDEI·CurrentPeriodEndDateDEI
 *   ctx      문맥 id → { start, end, instant, dims: ["축=멤버"] }
 *   facts    개념 → [{ ctx, v(숫자|null — nil·숫자 아님), unit, dec }]
 *   roles    본표 역할(검증기 자체 분류) → { kind: bs|is|ci|cf, cons, concepts: Set, neg: Set(negatedLabel 로 표시되는 개념) }
 *   calc     역할 → [부모, 자식, 가중치]
 */

const STD_PREFIX = /^(jppfs_cor|jpigp_cor|jpcrp_cor|jpdei_cor)$/;
/** 문자열로 남기는 jpcrp 요소 — 自己株式等 표의 소유자 이름(J1 주식수) */
const TEXT_FACTS = new Set(["NameOfShareholderTreasurySharesEtc"]);
const decodeXml = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&");
const attr = (s, n) => {
  const m = new RegExp(`(?:^|\\s)${n.replace(/[:.]/g, "\\$&")}="([^"]*)"`).exec(s);
  return m ? m[1] : null;
};

/** 링크 href 조각(#jppfs_cor_NetSales · #jpcrp030000-asr_E02144-000_SalesOfProductsIFRS) → 개념 열쇠 */
export function conceptOfHref(href) {
  const frag = href.slice(href.indexOf("#") + 1);
  const std = /^(jppfs_cor|jpigp_cor|jpcrp_cor|jpdei_cor)_(.+)$/.exec(frag);
  if (std) return `${std[1]}:${std[2]}`;
  const ext = /_E\d{5}-\d{3}_(.+)$/.exec(frag);
  return ext ? `ext:${ext[1]}` : `ext:${frag}`;
}

/**
 * 표시 구조 역할 → 본표 종류. 검증기 자체 규칙: 역할 이름(rol_…)이 대차대조표·재정상태표·손익·포괄손익·현금흐름표를 가리키고 주석·자본변동·
 * 부문·경영지표가 아닌 것. 연결 = 이름에 Consolidated. 옛 IFRS 四半期報告書 3개월 본표(QuarterPeriod)는 제외(누적만 본다).
 */
export function stmtKindOfRole(uri) {
  const r = uri.split("/").pop();
  if (!/^rol_/.test(r)) return null;
  if (/Notes|ChangesIn|Segment|SummaryOf|BusinessResults|QuarterPeriod/.test(r)) return null;
  const cons = /Consolidated/.test(r);
  let kind = null;
  if (/CashFlow/.test(r)) kind = "cf";
  else if (/BalanceSheet|FinancialPosition/.test(r)) kind = "bs";
  else if (/IncomeAndComprehensiveIncome|ProfitOrLossAndOtherComprehensiveIncome|ComprehensiveIncomeSingleStatement/.test(r)) kind = "is";
  else if (/ComprehensiveIncome/.test(r)) kind = "ci";
  else if (/StatementOfIncome|StatementsOfIncome|ProfitOrLoss/.test(r)) kind = "is";
  return kind ? { kind, cons, role: r } : null;
}

function parseLinkbase(xml, kind) {
  const out = new Map();
  const linkRe = new RegExp(`<(?:[\\w-]+:)?${kind}Link\\b([^>]*)>([\\s\\S]*?)</(?:[\\w-]+:)?${kind}Link>`, "g");
  for (const m of xml.matchAll(linkRe)) {
    const role = attr(m[1], "xlink:role");
    if (!role) continue;
    const locs = new Map();
    for (const l of m[2].matchAll(/<(?:[\w-]+:)?loc\b([^>]*?)\/?>/g)) {
      const href = attr(l[1], "xlink:href"), lab = attr(l[1], "xlink:label");
      if (href && lab) locs.set(lab, conceptOfHref(href));
    }
    const arcs = [];
    for (const a of m[2].matchAll(new RegExp(`<(?:[\\w-]+:)?${kind}Arc\\b([^>]*?)/?>`, "g"))) {
      const f = locs.get(attr(a[1], "xlink:from")), t = locs.get(attr(a[1], "xlink:to"));
      if (!f || !t) continue;
      arcs.push({ from: f, to: t, pl: attr(a[1], "preferredLabel"), w: Number(attr(a[1], "weight") ?? 1), use: attr(a[1], "use") });
    }
    const cur = out.get(role) ?? [];
    out.set(role, cur.concat(arcs));
  }
  return out;
}

export function parseDoc(files) {
  const names = Object.keys(files);
  const inst = files[names.find((n) => /\.xbrl$/.test(n))];
  const pre = files[names.find((n) => /_pre\.xml$/.test(n))];
  const cal = files[names.find((n) => /_cal\.xml$/.test(n))] ?? "";
  if (!inst || !pre) throw new Error("XBRL 인스턴스·표시 구조 없음");

  // 이름공간 접두어 → 열쇠 앞부분
  const pfx = new Map();
  const rootTag = inst.slice(0, inst.indexOf(">", inst.indexOf("<xbrli:xbrl")) + 1) || inst.slice(0, 30000);
  for (const m of rootTag.matchAll(/xmlns:([\w.-]+)="([^"]+)"/g)) {
    const std = /\/(jp[a-z]+_cor)$/.exec(m[2]);
    if (std && STD_PREFIX.test(std[1])) pfx.set(m[1], std[1]);
    else if (/\/E\d{5}-\d{3}\//.test(m[2])) pfx.set(m[1], "ext");
  }

  const ctx = new Map();
  for (const m of inst.matchAll(/<(?:xbrli:)?context\b[^>]*?\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?context>/g)) {
    const b = m[2];
    const dims = [...b.matchAll(/<(?:xbrldi:)?explicitMember\b[^>]*dimension="([^"]+)"[^>]*>([^<]+)</g)].map((d) => `${d[1].split(":").pop()}=${d[2].trim().split(":").pop()}`);
    if (/typedMember/.test(b)) dims.push("typed");
    const i = /<(?:xbrli:)?instant>\s*([^<\s]+)/.exec(b), s = /<(?:xbrli:)?startDate>\s*([^<\s]+)/.exec(b), e = /<(?:xbrli:)?endDate>\s*([^<\s]+)/.exec(b);
    ctx.set(m[1], { instant: i?.[1] ?? null, start: s?.[1] ?? null, end: e?.[1] ?? null, dims });
  }

  const facts = new Map();
  const texts = new Map();
  /** 주석 문단 [{ name, t }] */
  const tbs = [];
  const dei = {};
  const re = /<([\w.-]+):([\w.-]+)\b([^>]*?\bcontextRef="[^"]+"[^>]*?)(\/>|>([\s\S]*?)<\/\1:\2>)/g;
  for (const m of inst.matchAll(re)) {
    const p = pfx.get(m[1]);
    if (!p) continue;
    const a = m[3];
    const raw = m[5];
    if (p === "jpdei_cor") { if (raw != null && !/</.test(raw)) dei[m[2]] = raw.trim(); continue; }
    if (raw != null && (raw.includes("<") || /^Notes\w*TextBlock$/.test(m[2]))) {
      // 연결 주석 문단(J2 재무활동 부채 변동표 판독) — 차원 없는 문맥만, 태그 걷고 NFKC(전각 숫자·괄호 → 반각)
      // (메모리 — 리스부채·재무활동 문단만 남긴다)
      if (/^Notes\w*TextBlock$/.test(m[2]) && ctx.get(attr(a, "contextRef"))?.dims.length === 0 && /リース負債|財務活動/.test(raw)) {
        tbs.push({ name: m[2], t: decodeXml(decodeXml(raw).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ")).normalize("NFKC").replace(/\s+/g, " ").trim() });
      }
      continue;
    }
    if (TEXT_FACTS.has(m[2]) && p === "jpcrp_cor") {
      const arr = texts.get(m[2]) ?? [];
      arr.push({ ctx: attr(a, "contextRef"), s: decodeXml(raw ?? "").trim() });
      texts.set(m[2], arr);
      continue;
    }
    const nil = /xsi:nil="true"/.test(a) || raw == null || raw.trim() === "";
    const unit = attr(a, "unitRef");
    if (!unit) continue;
    const n = nil ? null : Number(raw.trim());
    if (n != null && !Number.isFinite(n)) continue;
    const k = `${p}:${m[2]}`;
    const arr = facts.get(k) ?? [];
    arr.push({ ctx: attr(a, "contextRef"), v: n, unit, dec: attr(a, "decimals") });
    facts.set(k, arr);
  }

  const roles = new Map();
  const preLinks = parseLinkbase(pre, "presentation");
  for (const [uri, arcs] of preLinks) {
    const c = stmtKindOfRole(uri);
    if (!c) continue;
    const concepts = new Set(), neg = new Set(), pls = new Map();
    for (const a of arcs) {
      concepts.add(a.from);
      concepts.add(a.to);
      if (a.pl && /negated/i.test(a.pl)) neg.add(a.to);
      // 기초·기말 잔액 줄(현금흐름표 現金及び現金同等物の期首·期末残高 — 같은 개념이 두 번)
      const pl = a.pl && /periodStart/i.test(a.pl) ? "s" : a.pl && /periodEnd/i.test(a.pl) ? "e" : "";
      // 출현마다 한 글자(이름표 없음 = "-") — 같은 개념이 그 서류 본표에 몇 번 나오는지 셀 수 있게
      pls.set(a.to, (pls.get(a.to) ?? "") + (pl || "-"));
    }
    // 현금흐름표의 시점(instant) 개념에 기초·기말 이름표가 없으면 기말(XBRL 시점 값의 기본 표시 — 第一三共 期末残高(連結財政状態計算書計上額)·
    // …IfDifferentFromBSBalance). 사실이 시점 문맥뿐인 개념만
    if (c.kind === "cf") {
      for (const [k, s] of pls) {
        const fs = facts.get(k) ?? [];
        if (s.includes("-") && fs.length && fs.every((f) => ctx.get(f.ctx)?.instant)) pls.set(k, s.replace(/-/g, "e"));
      }
    }
    roles.set(c.role, { ...c, concepts, neg, pls });
  }
  const calc = new Map();
  for (const [uri, arcs] of parseLinkbase(cal, "calculation")) calc.set(uri.split("/").pop(), arcs.filter((a) => a.use !== "prohibited").map((a) => [a.from, a.to, a.w]));
  return { dei, ctx, facts, texts, tbs, roles, calc };
}

/** 차원 없는 문맥의 값 — 기간(start~end) 또는 시점(instant). 같은 기간 문맥이 여럿이고 값이 다르면 { conflict } */
export function plainValue(doc, concept, { start = null, end = null, instant = null }) {
  const arr = doc.facts.get(concept);
  if (!arr) return undefined;
  let found;
  for (const f of arr) {
    const c = doc.ctx.get(f.ctx);
    if (!c || c.dims.length) continue;
    const hit = instant ? c.instant === instant : c.start === start && c.end === end;
    if (!hit) continue;
    if (found === undefined) found = f;
    else if (found.v !== f.v) return { conflict: [found.v, f.v] };
  }
  return found;
}
/** 개별(NonConsolidatedMember 하나) 문맥의 값 — 경영지표 개별 칸(DPS) */
export function ncValue(doc, concept, { start = null, end = null, instant = null }) {
  const arr = doc.facts.get(concept);
  if (!arr) return undefined;
  for (const f of arr) {
    const c = doc.ctx.get(f.ctx);
    if (!c || c.dims.length !== 1 || !/NonConsolidatedMember$/.test(c.dims[0])) continue;
    if (instant ? c.instant === instant : c.start === start && c.end === end) return f;
  }
  return undefined;
}

/** 서류 안의 사업연도 기간 후보(차원 없는 기간 문맥 중 300~400일) → [{ start, end }] */
export function fyPeriods(doc) {
  const out = new Map();
  for (const c of doc.ctx.values()) {
    if (c.dims.length || !c.start || !c.end) continue;
    const d = (Date.parse(c.end) - Date.parse(c.start)) / 864e5;
    if (d >= 300 && d <= 400) out.set(`${c.start}_${c.end}`, { start: c.start, end: c.end });
  }
  return [...out.values()];
}
