/**
 * XBRL 판독 공통(설계 10 §1.1-2) — 인스턴스·링크베이스(_cal·_pre·_def)·라벨. SEC·DART·EDINET 이 같은 XBRL 2.1 이라 한 벌.
 * 앱 코드와 무관하게 검증기가 따로 읽는다(§1.3). 숫자는 부동소수로 바꾸지 않는다 — 원문 문자열 그대로(§2.1 원칙).
 */

const attr = (s, name) => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(s);
  return m ? m[1] : null;
};
const local = (q) => (q ?? "").split(":").pop();
const unesc = (s) => s
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, "\u00a0").replace(/&amp;/g, "&");

/**
 * 문맥: id → { start, end, instant, dims: [{axis, member, typed}] , entity }
 */
export function parseContexts(xml) {
  const ctx = new Map();
  for (const m of xml.matchAll(/<(?:[A-Za-z0-9_-]+:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?context>/g)) {
    const b = m[2];
    const dims = [];
    for (const d of b.matchAll(/<(?:[A-Za-z0-9_-]+:)?explicitMember\b([^>]*)>\s*([^<]*?)\s*<\/(?:[A-Za-z0-9_-]+:)?explicitMember>/g)) {
      dims.push({ axis: attr(d[1], "dimension"), member: d[2].trim(), typed: false });
    }
    for (const d of b.matchAll(/<(?:[A-Za-z0-9_-]+:)?typedMember\b([^>]*)>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?typedMember>/g)) {
      dims.push({ axis: attr(d[1], "dimension"), member: d[2].replace(/<[^>]+>/g, "").trim() || "(typed)", typed: true });
    }
    ctx.set(m[1], {
      start: /<(?:[A-Za-z0-9_-]+:)?startDate>\s*([^<\s]+)/.exec(b)?.[1] ?? null,
      end: /<(?:[A-Za-z0-9_-]+:)?endDate>\s*([^<\s]+)/.exec(b)?.[1] ?? null,
      instant: /<(?:[A-Za-z0-9_-]+:)?instant>\s*([^<\s]+)/.exec(b)?.[1] ?? null,
      entity: /<(?:[A-Za-z0-9_-]+:)?identifier\b[^>]*>\s*([^<\s]+)/.exec(b)?.[1] ?? null,
      dims,
    });
  }
  return ctx;
}

/** 단위: id → "USD" | "shares" | "USD/shares" | "pure" … (측정값 로컬 이름, 나눗셈은 "/") */
export function parseUnits(xml) {
  const units = new Map();
  for (const m of xml.matchAll(/<(?:[A-Za-z0-9_-]+:)?unit\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?unit>/g)) {
    const b = m[2];
    const meas = (s) => [...s.matchAll(/<(?:[A-Za-z0-9_-]+:)?measure>\s*([^<\s]+)\s*</g)].map((x) => local(x[1]));
    const num = /<(?:[A-Za-z0-9_-]+:)?unitNumerator>([\s\S]*?)<\//.exec(b);
    const den = /<(?:[A-Za-z0-9_-]+:)?unitDenominator>([\s\S]*?)<\//.exec(b);
    units.set(m[1], num && den ? `${meas(num[1]).join("*")}/${meas(den[1]).join("*")}` : meas(b).join("*"));
  }
  return units;
}

/**
 * 사실 전부(문맥이 있는 요소). 숫자 사실은 value 원문 문자열 그대로, 문장 사실(text block)은 길이만 남기고 내용은 opt.keepText 일 때만.
 * → [{ concept: "prefix:name", contextRef, unitRef, decimals, nil, raw, id, ctx, unit }]
 */
export function parseFacts(xml, { keepText = false } = {}) {
  const ctx = parseContexts(xml);
  const units = parseUnits(xml);
  const out = [];
  const re = /<([A-Za-z][A-Za-z0-9_-]*:[A-Za-z][A-Za-z0-9_.-]*)\b([^>]*\bcontextRef="[^"]*"[^>]*?)(\/>|>([\s\S]*?)<\/\1>)/g;
  for (const m of xml.matchAll(re)) {
    const a = m[2];
    const contextRef = attr(a, "contextRef");
    const unitRef = attr(a, "unitRef");
    const nil = /\bxsi:nil="true"/.test(a);
    const body = m[4] ?? "";
    const numeric = unitRef != null;
    const raw = numeric ? body.trim() : null;
    out.push({
      concept: m[1],
      contextRef,
      unitRef,
      decimals: attr(a, "decimals"),
      nil,
      raw: numeric ? raw : keepText ? unesc(body) : null,
      textLength: numeric ? null : body.length,
      id: attr(a, "id"),
      ctx: ctx.get(contextRef) ?? null,
      unit: unitRef ? units.get(unitRef) ?? unitRef : null,
    });
  }
  return { facts: out, contexts: ctx, units };
}

/**
 * 링크베이스 호(arc) — kind = calculation | presentation | definition.
 * → [{ role, arcs: [{ from, to, order, weight, preferredLabel, arcrole }] }]  (from/to = 요소 id — "us-gaap_Revenues" 꼴)
 */
export function parseLinkbase(xml, kind) {
  const out = [];
  xml = xml.replace(new RegExp(`<(?:[A-Za-z0-9_-]+:)?${kind}Link\\b[^>]*\\/>`, "g"), "");
  for (const m of xml.matchAll(new RegExp(`<(?:[A-Za-z0-9_-]+:)?${kind}Link\\b([^>]*)>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_-]+:)?${kind}Link>`, "g"))) {
    const role = attr(m[1], "xlink:role") ?? "";
    const loc = new Map();
    for (const l of m[2].matchAll(/<(?:[A-Za-z0-9_-]+:)?loc\b([^>]*)\/?>/g)) {
      const id = attr(l[1], "xlink:label");
      const h = /xlink:href="[^"#]*#([^"]+)"/.exec(l[1])?.[1];
      if (id && h) loc.set(id, h);
    }
    const arcs = [];
    for (const a of m[2].matchAll(new RegExp(`<(?:[A-Za-z0-9_-]+:)?${kind}Arc\\b([^>]*)\\/?>`, "g"))) {
      const from = loc.get(attr(a[1], "xlink:from") ?? "");
      const to = loc.get(attr(a[1], "xlink:to") ?? "");
      if (!from || !to) continue;
      arcs.push({
        from, to,
        order: attr(a[1], "order"),
        weight: attr(a[1], "weight"),
        preferredLabel: attr(a[1], "preferredLabel"),
        arcrole: attr(a[1], "xlink:arcrole"),
      });
    }
    out.push({ role, arcs });
  }
  return out;
}

/** 라벨: 요소 id → [{ role, lang, text }] (documentation 역할 제외) */
export function parseLabels(xml) {
  const loc = new Map(), text = new Map(), out = new Map();
  for (const l of xml.matchAll(/<(?:[A-Za-z0-9_-]+:)?loc\b([^>]*)\/?>/g)) {
    const id = attr(l[1], "xlink:label");
    const h = /xlink:href="[^"#]*#([^"]+)"/.exec(l[1])?.[1];
    if (id && h) loc.set(id, h);
  }
  for (const m of xml.matchAll(/<(?:[A-Za-z0-9_-]+:)?label\b([^>]*)>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?label>/g)) {
    const id = attr(m[1], "xlink:label");
    const role = attr(m[1], "xlink:role") ?? "http://www.xbrl.org/2003/role/label";
    if (!id || /documentation/i.test(role)) continue;
    text.set(id, [...(text.get(id) ?? []), { role, lang: attr(m[1], "xml:lang"), text: unesc(m[2].replace(/<[^>]+>/g, "").trim()) }]);
  }
  for (const a of xml.matchAll(/<(?:[A-Za-z0-9_-]+:)?labelArc\b([^>]*)\/?>/g)) {
    const f = loc.get(attr(a[1], "xlink:from") ?? "");
    const t = text.get(attr(a[1], "xlink:to") ?? "");
    if (f && t) out.set(f, [...(out.get(f) ?? []), ...t]);
  }
  return out;
}

/** 요소 id("us-gaap_Revenues", "ifrs-full_Revenue", "jppfs_cor_NetSales") → QName("us-gaap:Revenues") — 접두어는 마지막 '_' 앞(요소 이름에 '_' 없음 가정) */
export function idToQName(id) {
  const i = id.lastIndexOf("_");
  return i < 0 ? id : `${id.slice(0, i)}:${id.slice(i + 1)}`;
}

/**
 * 표시 구조 한 역할의 트리 → 줄 목록 [{ id, parent, depth, order, preferredLabel, path }] (표시 순서대로)
 */
export function presentationTree(role) {
  const kids = new Map();
  const hasParent = new Set();
  for (const a of role.arcs) {
    if (!kids.has(a.from)) kids.set(a.from, []);
    kids.get(a.from).push(a);
    hasParent.add(a.to);
  }
  for (const v of kids.values()) v.sort((x, y) => Number(x.order ?? 0) - Number(y.order ?? 0));
  const roots = [...kids.keys()].filter((k) => !hasParent.has(k));
  const out = [];
  const seen = new Set();
  const walk = (id, parent, depth, order, pl, path) => {
    const key = `${parent}>${id}`;
    if (seen.has(key) || depth > 40) return;
    seen.add(key);
    out.push({ id, parent, depth, order, preferredLabel: pl, path });
    for (const a of kids.get(id) ?? []) walk(a.to, id, depth + 1, a.order, a.preferredLabel, [...path, id]);
  };
  for (const r of roots) walk(r, null, 0, null, null, []);
  return out;
}

/** 계산 구조 한 역할 → 부모 → [{ to, weight }] */
export function calculationMap(role) {
  const m = new Map();
  for (const a of role.arcs) {
    if (!m.has(a.from)) m.set(a.from, []);
    m.get(a.from).push({ to: a.to, weight: a.weight });
  }
  return m;
}
