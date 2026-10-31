/**
 * 출처 판정 공용 규칙 — 발표자료(점유율·투자포인트)의 API 채우기·커넥터 채우기가 같이 쓴다(오너 2026-10-31: 검증 코드는 하나).
 * 주간 리포트 커넥터의 무효 출처 규칙(`src/lib/weekly/generate.ts` isLowGradeSource)과 같은 목록이다.
 */

/** 근거로 인정하지 않는 출처 — 개인 블로그·커뮤니티·SNS·동영상(오너 2026-10-10) */
const LOW_GRADE_HOST_RE =
  /(^|\.)(tistory\.com|blogspot\.com|wordpress\.com|brunch\.co\.kr|medium\.com|substack\.com|velog\.io|reddit\.com|youtube\.com|youtu\.be|x\.com|twitter\.com|facebook\.com|instagram\.com|threads\.net|dcinside\.com|ppomppu\.co\.kr|clien\.net|fmkorea\.com|theqoo\.net|naver\.me|firebat\.co\.kr|linkedin\.com|quora\.com)$/i;

/** 무효 출처면 사유, 아니면 null. 주소가 깨졌으면 무효. */
export function lowGradeReason(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "주소 형식 오류";
  }
  if (!/^https?:$/.test(u.protocol)) return "http(s) 주소 아님";
  if (LOW_GRADE_HOST_RE.test(u.hostname)) return `블로그·커뮤니티·SNS(${u.hostname})`;
  if (/^(blog|m\.blog|cafe|m\.cafe|post)\./i.test(u.hostname)) return `블로그·카페(${u.hostname})`;
  return null;
}

/** 발행일 YYYY-MM-DD(또는 YYYY-MM) 이고 미래가 아닌지 */
export function validPublishedAt(s: string | null | undefined, today = new Date()): boolean {
  if (!s || !/^\d{4}-\d{2}(-\d{2})?$/.test(s)) return false;
  const d = Date.parse(s.length === 7 ? `${s}-01` : s);
  return Number.isFinite(d) && d <= today.getTime() + 864e5;
}

/** 주소 비교용 정규화(끝 슬래시·#·추적 매개변수 제거, 소문자 호스트) */
export function normUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid)/i.test(k)) u.searchParams.delete(k);
    return `${u.protocol}//${u.hostname.toLowerCase()}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return url;
  }
}

/**
 * 비중(0~1)이 글에 나오는지 — 「36%」「36.0%」「36 %」「36 percent」「36퍼센트」. 소수 첫째 자리까지 맞으면 인정(반올림 표기 차이는 인정 안 함).
 */
export function percentAppears(value: number, text: string): boolean {
  const pct = value * 100;
  const cands = new Set<string>();
  const one = (Math.round(pct * 10) / 10).toFixed(1);
  cands.add(one);
  if (one.endsWith(".0")) cands.add(one.slice(0, -2));
  const two = (Math.round(pct * 100) / 100).toFixed(2);
  cands.add(two);
  const t = text.replace(/,/g, "");
  for (const c of cands) {
    const esc = c.replace(".", "\\.");
    if (new RegExp(`(^|[^\\d.])${esc}\\s*(%|퍼센트|percent|per cent)`, "i").test(t)) return true;
  }
  return false;
}

/** 글에서 단위가 붙은 수치를 뽑는다(%·배·원·달러·엔·조·억·만·건·명·대·bp) — 근거 대조용 */
export function numbersWithUnits(text: string): string[] {
  const out: string[] = [];
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(%|퍼센트|배|조\s*원|억\s*원|만\s*원|원|조\s*달러|억\s*달러|달러|조\s*엔|억\s*엔|엔|건|명|대|bp)/gi;
  for (const m of text.matchAll(re)) out.push(`${m[1].replace(/,/g, "")}${m[2].replace(/\s+/g, "")}`);
  return out;
}

/** 수치 하나(numbersWithUnits 결과)가 근거 글에 같은 숫자·단위로 있는지 */
export function numberInText(num: string, text: string): boolean {
  const m = /^([\d.]+)(.*)$/.exec(num);
  if (!m) return false;
  const [, n, unit] = m;
  const t = text.replace(/,/g, "").replace(/\s+/g, "");
  return t.includes(`${n}${unit}`) || (unit === "%" && t.includes(`${n}퍼센트`));
}
