/**
 * 발표자료 점유율·투자포인트 검증 — API 채우기(claude-fill)와 커넥터 채우기(mcp-ppt, 다음 단계)가 같은 함수를 쓴다(오너 2026-10-31).
 *
 * 근거(evidence): 출처 주소별 본문 조각. API 채우기는 웹검색 인용문(cited_text — Anthropic 이 검색 결과에서 그대로 떼어 준 글),
 * 커넥터 채우기는 앱이 출처 주소를 직접 받아 읽은 본문. 숫자는 그 출처의 근거 글에 같은 값으로 있어야 남는다(지어낸 숫자 차단).
 */
import { lowGradeReason, normUrl, numberInText, numbersWithUnits, percentAppears, validPublishedAt } from "./sources";
import type { PptPoint, PptPointKind, PptShare, PptShareRow, PptSource } from "./store";

export interface Evidence {
  /** 정규화한 주소 → 그 주소의 근거 글들 */
  textsByUrl: Map<string, string[]>;
  /** 실제로 검색·조회된 주소(이 밖의 주소는 출처로 인정하지 않음). null 이면 검사 안 함(커넥터 — 앱이 직접 받아 본 주소만 textsByUrl 에 있음) */
  retrievedUrls: Set<string> | null;
}

export function emptyEvidence(): Evidence {
  return { textsByUrl: new Map(), retrievedUrls: null };
}

export function addEvidence(ev: Evidence, url: string, text: string) {
  const k = normUrl(url);
  const arr = ev.textsByUrl.get(k) ?? [];
  arr.push(text);
  ev.textsByUrl.set(k, arr);
}

function checkSources(sources: PptSource[] | undefined, ev: Evidence, errors: string[]): PptSource[] {
  const ok: PptSource[] = [];
  for (const s of sources ?? []) {
    const label = `${s?.org ?? "?"} ${s?.url ?? ""}`;
    if (!s?.org?.trim() || !s?.url) {
      errors.push(`출처 무효(기관·주소 없음): ${label}`);
      continue;
    }
    const low = lowGradeReason(s.url);
    if (low) {
      errors.push(`출처 무효(${low}): ${label}`);
      continue;
    }
    if (!validPublishedAt(s.publishedAt)) {
      errors.push(`출처 무효(발행일 없음·형식 오류 「${s.publishedAt ?? ""}」): ${label}`);
      continue;
    }
    if (ev.retrievedUrls && !ev.retrievedUrls.has(normUrl(s.url))) {
      errors.push(`출처 무효(이번 검색 결과에 없는 주소): ${label}`);
      continue;
    }
    ok.push({ org: s.org.trim(), title: (s.title ?? "").trim(), publishedAt: s.publishedAt, url: s.url });
  }
  return ok;
}

function textsFor(sources: PptSource[], ev: Evidence): string[] {
  return sources.flatMap((s) => ev.textsByUrl.get(normUrl(s.url)) ?? []);
}

export interface ShareInput {
  business: string;
  asOf: string;
  rows: (PptShareRow & { self?: boolean })[];
  sources: PptSource[];
}

export interface ShareResult {
  ok: boolean;
  share: PptShare | null;
  errors: string[];
  warnings: string[];
  /** 사람이 골라야 함(기존 값·사업보고서 본문 값과 크게 다름) */
  needsChoice: boolean;
}

/** 점유율 검증. existing = 같은 종목의 저장된 값, reportSelf = 사업보고서 본문의 자사 점유율(한국, 있으면). */
export function validateShare(
  input: ShareInput,
  ev: Evidence,
  opts: { companyName: string; existing?: PptShare | null; reportSelf?: { value: number; org: string; asOf: string } | null },
): ShareResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!input?.business?.trim()) errors.push("사업 이름 없음");
  if (!input?.asOf?.trim()) errors.push("기준 시점 없음");
  const sources = checkSources(input?.sources, ev, errors);
  if (!sources.length) errors.push("유효한 출처가 없음(조사기관·발행일·주소 필수, 블로그·SNS 무효)");
  const rows0 = (input?.rows ?? []).filter((r) => r && r.name && !/^(기타|others?|etc\.?)$/i.test(r.name.trim()));
  const rows: (PptShareRow & { self?: boolean })[] = [];
  for (const r of rows0) {
    if (!(typeof r.value === "number" && r.value > 0 && r.value <= 1)) {
      errors.push(`비중 범위 오류(0 초과 1 이하): ${r.name} ${r.value}`);
      continue;
    }
    rows.push({ name: r.name.trim(), value: r.value, ...(r.self ? { self: true } : {}) });
  }
  const sum = rows.reduce((a, r) => a + r.value, 0);
  if (sum > 1.005) errors.push(`비중 합이 100% 를 넘음(${(sum * 100).toFixed(1)}%)`);
  if (errors.length && (!sources.length || sum > 1.005 || !input?.business || !input?.asOf)) {
    return { ok: false, share: null, errors, warnings, needsChoice: false };
  }
  // 숫자 대조 — 출처 근거 글에 같은 비중이 없는 항목은 뺀다(지어내지 않음)
  const texts = textsFor(sources, ev);
  const kept: (PptShareRow & { self?: boolean })[] = [];
  for (const r of rows) {
    if (texts.some((t) => percentAppears(r.value, t))) kept.push(r);
    else warnings.push(`출처 근거 글에서 확인 안 된 비중 — 뺌: ${r.name} ${(r.value * 100).toFixed(1)}%`);
  }
  const self = kept.find((r) => r.self) ?? kept.find((r) => r.name.replace(/\s/g, "").includes(opts.companyName.replace(/\s/g, "")));
  if (!self) {
    errors.push(`이 회사(${opts.companyName}) 비중이 출처로 확인되지 않음`);
    return { ok: false, share: null, errors, warnings, needsChoice: false };
  }
  // 이 회사를 첫 줄로(도넛 0번 조각 = 강조색), 나머지는 큰 순
  const ordered = [self, ...kept.filter((r) => r !== self).sort((a, b) => b.value - a.value)].map(({ name, value }) => ({ name, value }));
  const keptSum = ordered.reduce((a, r) => a + r.value, 0);
  if (keptSum < 0.995) ordered.push({ name: "기타", value: Math.round((1 - keptSum) * 10000) / 10000 }); // 남는 몫 — 계산으로만
  let needsChoice = false;
  const ex = opts.existing;
  if (ex && ex.business === input.business.trim()) {
    const exSelf = ex.rows[0]?.value ?? null;
    if (exSelf != null && Math.abs(exSelf - self.value) >= 0.1) {
      warnings.push(`기존 값과 크게 다름: ${(exSelf * 100).toFixed(1)}% → ${(self.value * 100).toFixed(1)}%`);
      needsChoice = true;
    }
  }
  const rs = opts.reportSelf;
  if (rs && Math.abs(rs.value - self.value) >= 0.0005) {
    warnings.push(`사업보고서 본문 자사 점유율과 다름: ${(rs.value * 100).toFixed(1)}%(${rs.org}, ${rs.asOf}) vs ${(self.value * 100).toFixed(1)}% — 둘 다 보여 주고 사람이 고름`);
    needsChoice = true;
  }
  return {
    ok: true,
    share: { business: input.business.trim(), asOf: input.asOf.trim(), rows: ordered, sources, verified: texts.length ? "confirmed" : "unconfirmed", warnings },
    errors,
    warnings,
    needsChoice,
  };
}

const KINDS: PptPointKind[] = ["founding", "business", "thesis"];
/** 개요 칸 한 줄 폭(14pt, 26.6cm) 근사 — 한글 1em·띄어쓰기 0.3em·그 밖 0.55em */
const LINE_CM = 27.38 - 0.79;
export function pointWidthCm(s: string): number {
  const em = [...s].reduce((a, c) => a + (/[가-힣ㄱ-ㅎ一-龥ぁ-ヿ]/.test(c) ? 1 : c === " " ? 0.3 : 0.55), 0);
  return ((em * 14 - s.length * 0.8) / 72) * 2.54;
}

export interface PointsResult {
  lines: PptPoint[];
  dropped: { kind: string; text: string; reason: string }[];
  warnings: string[];
}

/**
 * 투자포인트 세 줄 검증(오너 2026-10-31): ① 설립연도·사업·점유율 ② 사업 부문·차별점 ③ 종합.
 * allowedNumbers = 앱이 준 값(점유율 칸 값·재무 요약 등) — 이 값이거나 그 줄 출처 근거 글에 있는 수치만 남는다.
 */
export function validatePoints(
  input: PptPoint[],
  ev: Evidence,
  ctx: { allowedNumbers: string[]; foundingYear?: number | null; shareSelfPct?: string | null },
): PointsResult {
  const dropped: PointsResult["dropped"] = [];
  const warnings: string[] = [];
  const lines: PptPoint[] = [];
  for (const kind of KINDS) {
    const p = (input ?? []).find((x) => x?.kind === kind);
    if (!p || !p.text?.trim()) {
      dropped.push({ kind, text: "", reason: "문장 없음" });
      continue;
    }
    const text = p.text.trim().replace(/\s+/g, " ");
    const errs: string[] = [];
    const sources = checkSources(p.sources, ev, errs);
    if (!sources.length) {
      dropped.push({ kind, text, reason: `유효한 출처 없음(${errs.join("; ") || "출처 없음"})` });
      continue;
    }
    if (kind === "thesis" && /목표\s*주가|목표가|상승\s*여력|업사이드|upside/i.test(text)) {
      dropped.push({ kind, text, reason: "근거 없는 목표가·상승여력 문구 금지" });
      continue;
    }
    if (kind === "founding" && ctx.foundingYear != null) {
      const y = /(\d{4})\s*년\s*(설립|창립|창업)/.exec(text);
      if (y && Number(y[1]) !== ctx.foundingYear) {
        dropped.push({ kind, text, reason: `설립연도가 원자료(${ctx.foundingYear})와 다름` });
        continue;
      }
    }
    const texts = textsFor(sources, ev);
    const allowed = new Set(ctx.allowedNumbers.map((s) => s.replace(/,/g, "").replace(/\s+/g, "")));
    if (ctx.shareSelfPct) allowed.add(ctx.shareSelfPct);
    const bad = numbersWithUnits(text).filter((n) => !allowed.has(n) && !texts.some((t) => numberInText(n, t)));
    if (bad.length) {
      dropped.push({ kind, text, reason: `출처 근거 글·앱 자료에 없는 수치: ${bad.join(", ")}` });
      continue;
    }
    if (errs.length) warnings.push(`${kind}: 일부 출처 무효 — ${errs.join("; ")}`);
    const w = pointWidthCm(text);
    if (w > LINE_CM) warnings.push(`${kind}: 한 줄 폭 넘침(${w.toFixed(1)}cm / ${LINE_CM.toFixed(1)}cm) — 글을 줄여야 함`);
    lines.push({ kind, text, sources });
  }
  return { lines, dropped, warnings };
}
