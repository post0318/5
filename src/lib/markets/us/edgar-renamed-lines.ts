import "server-only";
import { fetchJson, fetchText } from "../http";
import type { CompanyFacts, FactUnitEntry } from "./edgar";
import type { RecentFilings } from "./edgar-gapfill";

/**
 * **20-F 현금흐름표 — 같은 본표 줄을 옛 공시는 회사 고유 태그, 최신 공시는 표준 개념으로 단 경우**(2026-10-09, 검증기 전체 모드).
 *
 * TSM 자기주식 취득: 2022~2024 년 20-F 는 `tsm:PaymentForAcquireOfTreasuryShares`, 2025 년 20-F 는 `ifrs-full:PaymentsToAcquireOrRedeemEntitysShares`
 * (본표 라벨은 둘 다 "Treasury stock acquired"). 앱은 표준 개념만 읽어 2022 년 열이 "본표에 별도 줄 없음" 빈칸이었다(실제 871.6 백만 TWD).
 * 최신 20-F 현금흐름표 본표의 표준 개념 S 와 옛 20-F 현금흐름표 본표의 회사 고유 개념 C 의 라벨이 하나라도 같으면(설명 라벨 제외) 같은 줄로 보고,
 * C 의 공시 원본 값(차원 없음·통화 단위)을 S 의 값이 없는 기간에만 넣는다. 두 개념이 함께 실린 기간이 있으면 값이 모두 같을 때만(부호·정의 확인).
 * 20-F 발행사만 — 10-K 는 앱이 본표 계산 구조로 따로 읽는다.
 */
const UA = process.env.SEC_USER_AGENT ?? "global-market-research (personal use) contact@example.com";
const H = { "user-agent": UA, "accept-encoding": "gzip, deflate" };
const STD = /^(ifrs-full|us-gaap)_/;
const SKIP = /^(dei|srt|country|currency|ecd)_/;

const cfRole = (role: string) => /CASHFLOW/i.test(role.replace(/[^A-Za-z]/g, "")) && !/Parenth|Detail|Table|Polic|Supplement/i.test(role);

/** 표시 구조(_pre.xml)의 현금흐름표 본표 개념 */
function cfFace(pre: string): Set<string> {
  const out = new Set<string>();
  for (const m of pre.matchAll(/<(?:[\w-]+:)?presentationLink\b[^>]*xlink:role="([^"]+)"[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?presentationLink>/g)) {
    if (!cfRole(m[1].split("/").pop() ?? "")) continue;
    for (const h of m[2].matchAll(/xlink:href="[^"#]*#([^"]+)"/g)) out.add(h[1]);
  }
  return out;
}

/** 라벨 파일 — 개념 → 라벨 문자열(소문자·공백 정리, 설명 라벨 제외) */
function labelsOf(lab: string): Map<string, Set<string>> {
  const loc = new Map<string, string>();
  for (const l of lab.matchAll(/<(?:[\w-]+:)?loc\b([^>]*)\/?>/g)) {
    const id = /xlink:label="([^"]+)"/.exec(l[1])?.[1], h = /xlink:href="[^"#]*#([^"]+)"/.exec(l[1])?.[1];
    if (id && h) loc.set(id, h);
  }
  const text = new Map<string, string[]>();
  for (const m of lab.matchAll(/<(?:[\w-]+:)?label\b([^>]*)>([^<]*)<\/(?:[\w-]+:)?label>/g)) {
    const id = /xlink:label="([^"]+)"/.exec(m[1])?.[1];
    if (!id || /documentation/i.test(m[1])) continue;
    text.set(id, [...(text.get(id) ?? []), m[2].replace(/\s+/g, " ").trim().toLowerCase()]);
  }
  const out = new Map<string, Set<string>>();
  for (const a of lab.matchAll(/<(?:[\w-]+:)?labelArc\b([^>]*)\/?>/g)) {
    const c = loc.get(/xlink:from="([^"]+)"/.exec(a[1])?.[1] ?? ""), t = text.get(/xlink:to="([^"]+)"/.exec(a[1])?.[1] ?? "");
    if (c && t) out.set(c, new Set([...(out.get(c) ?? []), ...t.filter(Boolean)]));
  }
  return out;
}

type Dur = { start: string; end: string; val: number; unit: string };

/** 인스턴스 — 개념 → 차원 없는 기간 값(통화 단위만) */
function durationFacts(xml: string, want: Set<string>): Map<string, Dur[]> {
  const ctx = new Map<string, { s: string; e: string }>();
  for (const m of xml.matchAll(/<(?:xbrli:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?context>/g)) {
    if (/dimension="/.test(m[2])) continue;
    const s = /<(?:xbrli:)?startDate>\s*([^<\s]+)/.exec(m[2])?.[1], e = /<(?:xbrli:)?endDate>\s*([^<\s]+)/.exec(m[2])?.[1];
    if (s && e) ctx.set(m[1], { s, e });
  }
  const units = new Map<string, string>();
  for (const m of xml.matchAll(/<(?:xbrli:)?unit\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?unit>/g)) {
    const ms = [...m[2].matchAll(/<(?:xbrli:)?measure>([^<]+)</g)].map((x) => x[1].trim().replace(/^.*:/, ""));
    if (ms.length === 1) units.set(m[1], ms[0]);
  }
  const out = new Map<string, Dur[]>();
  for (const m of xml.matchAll(/<([a-z0-9-]+):([A-Za-z0-9_]+)\b([^>]*)>\s*(-?[\d.]+)\s*<\/\1:\2>/g)) {
    const id = `${m[1]}_${m[2]}`;
    if (!want.has(id)) continue;
    const c = ctx.get(/contextRef="([^"]+)"/.exec(m[3])?.[1] ?? ""), u = units.get(/unitRef="([^"]+)"/.exec(m[3])?.[1] ?? "");
    if (!c || !u || !/^[A-Z]{3}$/.test(u)) continue;
    const arr = out.get(id) ?? [];
    if (!arr.some((x) => x.start === c.s && x.end === c.e && x.unit === u)) arr.push({ start: c.s, end: c.e, val: Number(m[4]), unit: u });
    out.set(id, arr);
  }
  return out;
}

type Concept = { label?: string; units: Record<string, FactUnitEntry[]> };

export async function withRenamedCfLines(cik: string, facts: CompanyFacts, recent: RecentFilings | null): Promise<CompanyFacts> {
  if (!recent) return facts;
  const f20: { accn: string; filed: string }[] = [];
  for (let i = 0; i < recent.form.length && f20.length < 5; i++) if (recent.form[i] === "20-F") f20.push({ accn: recent.accessionNumber[i], filed: recent.filingDate[i] });
  if (f20.length < 2) return facts;
  const opt = { headers: H, revalidate: 60 * 60 * 24, timeoutMs: 30_000 };
  const read = async (accn: string) => {
    const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accn.replace(/-/g, "")}`;
    const names = (await fetchJson<{ directory: { item: { name: string }[] } }>(`${base}/index.json`, opt)).directory.item.map((x) => x.name);
    const pre = names.find((n) => /_pre\.xml$/i.test(n)), lab = names.find((n) => /_lab\.xml$/i.test(n)), inst = names.find((n) => /_htm\.xml$/i.test(n));
    if (!pre || !lab || !inst) return null;
    return { base, face: cfFace(await fetchText(`${base}/${pre}`, opt)), labels: labelsOf(await fetchText(`${base}/${lab}`, opt)), inst };
  };
  const latest = await read(f20[0].accn);
  if (!latest) return facts;
  // 최신 공시 본표의 표준 개념 → 라벨
  const stdLab = new Map<string, Set<string>>();
  for (const id of latest.face) if (STD.test(id)) stdLab.set(id, latest.labels.get(id) ?? new Set());
  const add: { std: string; e: Dur; filed: string; accn: string }[] = [];
  for (const f of f20.slice(1)) {
    const r = await read(f.accn);
    if (!r) continue;
    const map = new Map<string, string>(); // 회사 고유 → 표준
    for (const id of r.face) {
      if (STD.test(id) || SKIP.test(id)) continue;
      const ls = r.labels.get(id);
      if (!ls?.size) continue;
      const hits = [...stdLab].filter(([, sl]) => [...ls].some((t) => sl.has(t))).map(([s]) => s);
      if (hits.length === 1) map.set(id, hits[0]);
    }
    if (!map.size) continue;
    const vals = durationFacts(await fetchText(`${r.base}/${r.inst}`, { headers: H, revalidate: false, timeoutMs: 30_000 }), new Set(map.keys()));
    for (const [c, arr] of vals) for (const e of arr) add.push({ std: map.get(c)!, e, filed: f.filed, accn: f.accn });
  }
  if (!add.length) return facts;
  const nsOf = (id: string) => (id.startsWith("ifrs-full_") ? "ifrs-full" : "us-gaap");
  const local = (id: string) => id.slice(id.indexOf("_") + 1);
  const F = facts.facts as unknown as Record<string, Record<string, Concept> | undefined>;
  const out: Record<string, Record<string, Concept>> = {};
  for (const std of new Set(add.map((a) => a.std))) {
    const cur = F[nsOf(std)]?.[local(std)];
    const ours = add.filter((a) => a.std === std);
    // 겹치는 기간 값이 모두 같아야(부호·정의 확인) — 하나라도 다르면 이 줄은 넣지 않는다
    const clash = ours.some((a) => (cur?.units?.[a.e.unit] ?? []).some((x) => x.start === a.e.start && x.end === a.e.end && x.val !== a.e.val));
    if (clash) continue;
    const units: Record<string, FactUnitEntry[]> = { ...(cur?.units ?? {}) };
    for (const a of ours) {
      const list = units[a.e.unit] ?? [];
      if (list.some((x) => x.start === a.e.start && x.end === a.e.end)) continue;
      const entry: FactUnitEntry & { accn: string } = { start: a.e.start, end: a.e.end, val: a.e.val, fy: Number(a.e.end.slice(0, 4)), fp: "FY", form: "20-F", filed: a.filed, accn: a.accn };
      units[a.e.unit] = [...list, entry];
    }
    (out[nsOf(std)] ??= {})[local(std)] = { ...(cur ?? {}), units };
  }
  if (!Object.keys(out).length) return facts;
  const next: Record<string, unknown> = { ...(facts.facts as object) };
  for (const [n0, cs] of Object.entries(out)) next[n0] = { ...((F[n0] ?? {}) as object), ...cs };
  return { ...facts, facts: next as CompanyFacts["facts"] };
}
