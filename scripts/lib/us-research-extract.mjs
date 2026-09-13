/**
 * 해외(미국) 리서치의 투자의견·목표주가 추출 — 국내 수집기와 같은 방식
 * (본문에서 먼저 찾고, 없으면 PDF 를 내려받아 텍스트에서 찾는다).
 *
 * 실측(2026-09)으로 확인한 한국 증권사 미국 리포트의 실태:
 *  - 자체 등급·목표주가를 아예 안 내는 경우가 많다(하나증권 글로벌 기업분석은
 *    PDF 전문 8천여 자에 관련 키워드 0건).
 *  - 키움: "목표주가 컨센서스: $243.41" — 자사 목표가가 아니라 시장 컨센서스.
 *  - 신한: "목표주가 (LSEG, 컨센서스) 248.8 달러" — 출처(LSEG)가 명시된 컨센서스.
 *  - 유진: "투자의견 NR" — 명시적 무등급.
 *  - 한화: 목표주가·투자의견이 면책 문구에만 등장("…의견을 제시합니다").
 *
 * 목표주가 정책(오너 확인, 2026-09): "해외는 본인들의 목표주가가 아니어도
 * 내용중 컨센서스가격이 존재하면 해당 가격을 표시" — 자사 목표가를 최우선
 * 으로 찾되, 없으면 컨센서스로 표기된 값이라도 채택한다(예전엔 컨센서스를
 * 아예 제외했었다). 다만 (1) 면책·방법론 안내 구간은 잘라내고 (2) 라벨
 * 바로 뒤에 오는 값만 인정한다 — 틀린 등급·아무 숫자나 줍는 것보다 빈칸이
 * 낫다는 원칙은 유지.
 *
 * PDF 는 건당 다운로드 비용이 있으므로 본문에서 못 찾은 항목에만 시도한다.
 */

import { PDFParse } from "pdf-parse";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

/** 면책·방법론 안내 문구 — 여기서 잡힌 등급은 실제 의견이 아니다. */
const DISCLAIMER_RE =
  /(의견을\s*제시|제시하고\s*있습니다|산정이나\s*투자의견\s*변경|투자등급\s*및\s*적용기준|compliance\s*notice)/i;

function withoutDisclaimer(text) {
  const t = String(text ?? "");
  const m = t.match(DISCLAIMER_RE);
  return m && m.index != null ? t.slice(0, m.index) : t;
}

/** 자사 목표가 — 라벨 바로 뒤에 값이 오고 "컨센서스" 언급이 없는 경우만. */
const OWN_TARGET_PATTERNS = [
  /목표\s*주가\s*\(?\$?\)?\s*[:：]?\s*\$\s*([\d,]+(?:\.\d+)?)/,
  /목표\s*주가[^\d$]{0,10}([\d,]+(?:\.\d+)?)\s*(?:달러|USD)/i,
  /(?:target\s*price|TP)\s*[:：]?\s*\$?\s*([\d,]+(?:\.\d+)?)/i,
];

/**
 * 컨센서스 목표가 — 자사 목표가를 못 찾았을 때만 폴백으로 쓴다. 실측으로
 * 확인된 표기 형태들만 좁게 인정한다(엉뚱한 숫자를 줍지 않도록 "컨센서스"
 * 라는 단어가 패턴 안에 반드시 들어있게 설계).
 */
const CONSENSUS_TARGET_PATTERNS = [
  // "목표주가 컨센서스: $243.41" (키움)
  /목표\s*주가\s*컨센서스\s*[:：]?\s*\$\s*([\d,]+(?:\.\d+)?)/i,
  // "목표주가 (LSEG, 컨센서스) 248.8 달러" (신한)
  /목표\s*주가\s*\([^)]*컨센서스[^)]*\)\s*\$?\s*([\d,]+(?:\.\d+)?)\s*(?:달러|USD)?/i,
  // "컨센서스 목표주가: $243.41" / "컨센서스 목표주가 243.41달러"
  /컨센서스\s*목표\s*주가\s*[:：]?\s*\$?\s*([\d,]+(?:\.\d+)?)\s*(?:달러|USD)?/i,
  // "Target Price (Consensus): $243.41"
  /target\s*price\s*\(?\s*consensus\s*\)?\s*[:：]?\s*\$?\s*([\d,]+(?:\.\d+)?)/i,
];

/** 투자의견 — 한글·영문·NR. 라벨 바로 뒤에 오는 값만 인정. */
const OPINION_RE =
  /투자의견\s*[:：]?\s*(N\.?R\.?|Not\s*Rated|적극매수|매수|매도|중립|보유|비중확대|비중축소|Strong\s*Buy|Buy|Sell|Hold|Neutral|Overweight|Underweight|Outperform|Market\s*Perform|Sector\s*Perform)/i;

function matchFirst(patterns, text) {
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const n = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0 && n < 100_000) return n;
  }
  return null;
}

export function extractTargetPrice(text) {
  const t = withoutDisclaimer(text);
  if (!t) return null;
  return matchFirst(OWN_TARGET_PATTERNS, t) ?? matchFirst(CONSENSUS_TARGET_PATTERNS, t);
}

export function extractOpinion(text) {
  const m = withoutDisclaimer(text).match(OPINION_RE);
  if (!m) return "";
  const v = m[1].replace(/\s+/g, " ").trim();
  return /^n\.?r\.?$|^not rated$/i.test(v) ? "NR" : v;
}

/** PDF 를 받아 텍스트를 뽑는다. 실패하면 빈 문자열(수집 자체는 계속). */
export async function readPdfText(pdfUrl) {
  if (!pdfUrl) return "";
  try {
    const res = await fetch(pdfUrl, { headers: { "User-Agent": UA } });
    if (!res.ok) return "";
    const buf = Buffer.from(await res.arrayBuffer());
    // pdf-parse v2 는 클래스 API — v1 의 default export 호출 방식이 아니다.
    const parser = new PDFParse({ data: buf });
    const { text } = await parser.getText();
    await parser.destroy();
    return String(text ?? "");
  } catch {
    return "";
  }
}

/**
 * 항목 배열을 돌며 비어 있는 opinion·targetPrice 를 본문 → PDF 순으로 채운다.
 * items 를 제자리에서 수정한다.
 */
export async function enrichUsResearch(
  items,
  { sleepMs = 400, log = console.log, usePdf = true } = {},
) {
  for (const it of items) {
    const body = `${it.summary ?? ""} ${it.title ?? ""}`;
    if (!it.opinion) it.opinion = extractOpinion(body);
    if (it.targetPrice == null) it.targetPrice = extractTargetPrice(body);
  }
  const missing = usePdf
    ? items.filter((it) => !it.opinion || it.targetPrice == null)
    : [];
  if (missing.length > 0) {
    log(`▶ PDF 확인 ${missing.length}건 (본문에서 못 찾은 항목만)...`);
    for (const it of missing) {
      const text = await readPdfText(it.pdfUrl);
      if (text) {
        if (!it.opinion) it.opinion = extractOpinion(text);
        if (it.targetPrice == null) it.targetPrice = extractTargetPrice(text);
      }
      await new Promise((r) => setTimeout(r, sleepMs));
    }
  }
  const withOpinion = items.filter((it) => it.opinion).length;
  const withTarget = items.filter((it) => it.targetPrice != null).length;
  log(`✔ 보강 완료 — 등급 ${withOpinion}/${items.length} · 목표주가 ${withTarget}/${items.length}`);
  return { withOpinion, withTarget };
}
