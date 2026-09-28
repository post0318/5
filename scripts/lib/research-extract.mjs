/**
 * 종목 리포트 투자의견·목표주가 공용 추출기 — 국내(kr)·해외(us) 공통.
 *
 * 오너 지시(2026-09-25 — "종목리포트는 국내냐 해외냐 구분없이 공용추출기가
 * 맞다", "어디서 찾는다. 순서는 어떻게 본다 이런거는 국내도 해외도 동일하다").
 * 예전엔 해외만 공용(`us-research-extract.mjs`, 삭제됨)이고 국내 수집기 14곳이 각자
 * 정규식을 두고 있었다 — 찾는 순서·허용 폭·면책 처리가 제각각이었다.
 *
 * ── 공통 규칙 ─────────────────────────────────────────────────────────
 *  C1 찾는 순서: 목록·API 칸(수집기가 채워 넘김) → 본문(요약·상세 페이지) → PDF.
 *  C2 목록·API 칸 값 검증: 칸에 값이 있어도 본문/PDF 에 "목표주가"·"투자의견"
 *     언급이 없으면 버린다(KB tp/recomm 이 속보 노트에도 채워져 있던 문제 —
 *     오너 결정 "모든 소스에 공통 적용"). 제목에서 읽은 의견
 *     (`opinionFrom: "title"`, 예: "삼성SDI(006400/BUY)")은 리포트 자체라 검증 제외.
 *  C3 면책·방법론·변동추이 구간은 잘라낸다(등급 설명표·과거 목표가 표 오탐 방지).
 *  C4 라벨 바로 뒤에 오는 값만 인정(조사·"(12M)" 같은 짧은 괄호·콜론만 허용).
 *  C5 목표가: 자체 목표가 → (해외만) 컨센서스.
 *  C6 애매하면 빈칸 — 틀린 값보다 낫다.
 *  C7 투자의견 공통 어휘, NR/Not Rated → "NR".
 *  C8 투자의견 표기: "투자의견 X" / "X 의견" / (PDF 앞부분 한정) 줄 맨 앞 "Buy(유지)"·"Buy\t상향".
 *  C10 산업분석(category "산업")은 대상 아님.
 *  C11 PDF 는 URL 당 한 번만 받는다(캐시). 수집기가 이미 받은 텍스트는
 *      `it.pdfText`·`it.bodyText` 로 넘기면 다시 받지 않는다(전송 전 수집기가 뺀다).
 *
 * ── 통화 = 각 시장의 통화(오너 지시 2026-09-25 — "통화단위는 각 시장의 통화단위를
 *    적용한다", "중국 일본 유럽도 시장은 추가해놔라"). 목표가는 그 시장 통화
 *    표기로만 인정하고, 규칙이 없는 시장은 추출하지 않는다(다른 시장 규칙으로
 *    잘못 읽지 않게 — C6).
 * ── 중국(ch, HKD·CNY)·일본(jp, JPY)·유럽(eu, EUR·GBP·CHF 등) ── 통화 기호/단위가
 *    숫자 앞이나 뒤에 반드시 붙은 값만 인정(자체 목표가·컨센서스 같은 형태).
 *    아직 실측 표본이 적어(KB 중국 2곳·키움 CH 게시판뿐) 패턴은 일반형이다 —
 *    실제 리포트에서 놓치는 표기가 나오면 여기에 추가.
 * ── 해외 전용(us, USD) ── 달러 표기 자체 목표가, 컨센서스 7종(실측), 가격 0~100,000.
 * ── 국내 전용(kr, KRW) ── 원화 표기(목표주가/목표가/적정주가/적정가격/TP N원·N만원,
 *    "목표주가 -원"=미제시), 가격 100~10,000,000. 국내는 컨센서스 표기 없음(오너 확인).
 */
import { PDFParse } from "pdf-parse";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

// ── 공통 ────────────────────────────────────────────────────────────────

/** C3 — 여기서부터 뒤는 실제 의견·목표가가 아니다. */
const DISCLAIMER_RE =
  /(의견을\s*제시|제시하고\s*있습니다|산정이나\s*투자의견\s*변경|투자등급\s*및\s*적용기준|투자등급\s*\(\s*\d{4}\s*년|투자의견\s*(?:및|\/)\s*목표\s*주가\s*(?:변동|변경|추이)|목표\s*주가\s*변동\s*추이|compliance\s*notice)/i;

function withoutDisclaimer(text) {
  const t = String(text ?? "");
  const m = t.match(DISCLAIMER_RE);
  return m && m.index != null ? t.slice(0, m.index) : t;
}

/** C7 — 공통 어휘(긴 표현을 앞에). */
const VOCAB =
  "적극\\s*매수|매수|매도|중립|보유|비중\\s*확대|비중\\s*축소|Strong\\s*Buy|Buy|Sell|Hold|Neutral|Overweight|Underweight|Outperform|Market\\s*Perform|Sector\\s*Perform|Trading\\s*Buy|Not\\s*Rated|N\\.?R\\.?";
// C8 — "투자의견 매수" / "투자의견(12M) : Buy"
// 신한은 "✓ 투자판단 매수 (유지)"처럼 "투자판단" 라벨을 쓴다(실측 2026-09-25).
const OPINION_LABEL_RE = new RegExp(`(?:투자의견|투자판단)\\s*(?:\\([^)]{0,10}\\))?\\s*[:：]?\\s*(${VOCAB})(?![A-Za-z])`, "i");
// C8 — "매수 의견과 목표주가 …" (한투)
const OPINION_WORD_FIRST_RE = new RegExp(`(?<![A-Za-z가-힣])(${VOCAB})\\s*의견`, "i");
// C8 — PDF 앞부분 헤더의 줄 맨 앞 등급: "Buy(유지)"(NH), "Buy\t상향"(교보).
const OPINION_HEAD_RE = new RegExp(
  `^\\s*(${VOCAB})\\s*(?:[(（]|\\t|$|(?:유지|상향|하향|신규)\\b)`,
  "im",
);
const PDF_HEAD_CHARS = 2000;
// C8 — 등급 변동 표시가 괄호로 붙은 줄 맨 앞 등급은 위치 무관(면책 구간 앞까지):
// 메리츠 "Buy (Maintain)"은 1페이지 본문 중간이라 앞부분 2,000자 밖(실측 2026-09-25).
const OPINION_QUALIFIED_LINE_RE = new RegExp(
  `^\\s*(${VOCAB})\\s*[(（]\\s*(?:유지|상향|하향|신규|하향조정|상향조정|Maintain|Upgrade|Downgrade|Initiate|New)\\s*[)）]`,
  "im",
);

function normalizeOpinion(v) {
  const s = v.replace(/\s+/g, " ").trim();
  return /^n\.?r\.?$|^not rated$/i.test(s) ? "NR" : s;
}

/** C2 — 본문/PDF 에 언급이 있는지(면책 구간 제외 후 판정). */
const TARGET_MENTION_RE = /목표\s*주가|목표가|적정\s*주가|적정\s*가격|\bTP\b|target\s*price/i;
const OPINION_MENTION_RE = /투자의견|투자판단|\brating\b/i;

// ── 시장별 ──────────────────────────────────────────────────────────────

const MARKET_RULES = {
  us: {
    currency: "USD",
    min: 0,
    max: 100_000,
    manwon: false,
    own: [
      /목표\s*주가\s*\(?\$?\)?\s*[:：]?\s*\$\s*([\d,]+(?:\.\d+)?)/,
      /목표\s*주가[^\d$]{0,10}([\d,]+(?:\.\d+)?)\s*(?:달러|USD)/i,
      /(?:target\s*price|TP)\s*[:：]?\s*\$?\s*([\d,]+(?:\.\d+)?)/i,
    ],
    // "컨센서스" 단어가 패턴 안에 반드시 들어있게(엉뚱한 숫자 방지). \s 는 줄바꿈 포함.
    consensus: [
      /목표\s*주가\s*컨센서스\s*[:：]?\s*\$\s*([\d,]+(?:\.\d+)?)/i, // 키움
      /목표\s*주가\s*\([^)]*컨센서스[^)]*\)\s*\$?\s*([\d,]+(?:\.\d+)?)\s*(?:달러|USD)?/i, // 신한
      /컨센서스\s*목표\s*주가(?:\s*\/\s*투자의견)?\s*[:：]?\s*\$?\s*([\d,]+(?:\.\d+)?)\s*(?:달러|USD)?/i, // 한화
      /TP\s*\(\s*컨센서스\s*\)\s*([\d,]+(?:\.\d+)?)\s*(?:달러|USD)/i, // 하나
      /컨센서스\s*TP\s*(?:USD|달러)?\s*([\d,]+(?:\.\d+)?)/i, // 현대차
      /consensus\s*target\s*price\s*\(?\s*(?:USD|달러)?\s*\)?\s*([\d,]+(?:\.\d+)?)/i, // KB
      /Refinitiv\s*평균\s*목표\s*주가\s*(?:USD|달러)?\s*\$?\s*([\d,]+(?:\.\d+)?)/i, // 미래에셋
    ],
  },
  kr: {
    currency: "KRW",
    min: 100,
    max: 10_000_000,
    manwon: true,
    // 라벨(+조사/짧은 괄호/콜론) 바로 뒤 "N원"·"N만원"·"-원"(미제시).
    own: [
      // "3.6만원"(한화) 같은 소수 만원도 — 소수점은 "만" 단위일 때만 인정(matchPrice).
      /(?:목표\s*주가|목표가|적정\s*주가|적정\s*가격|\bTP)(?:를|는|가|은)?\s*(?:\([^)]{0,10}\))?\s*[:：]?\s*([\d,]+(?:\.\d+)?|-)\s*(만)?\s*원/,
      // "원" 없는 표기(대신 "6개월 목표주가 560,000") — 천 단위 콤마가 있는 숫자만,
      // 뒤에 다른 단위(%·억·조·배·달러)가 오면 인정 안 함. 위 "원" 패턴보다 뒤에 둔다.
      /(?:목표\s*주가|목표가|적정\s*주가)\s*(?:\([^)]{0,10}\))?\s*[:：]?\s*(\d{1,3}(?:,\d{3})+)(?![\d,.]|\s*(?:%|억|조|배|달러|USD|\$|원))/,
    ],
    consensus: [],
  },
};

// 통화 기호·단위가 붙은 값만 받는 일반형 규칙(중국·일본·유럽).
function currencyRules({ currency, prefix, suffix, min, max }) {
  const NUM = String.raw`([\d,]+(?:\.\d+)?)`;
  const P = `(?:${prefix})`;
  const S = `(?:${suffix})`;
  const re = (src) => new RegExp(src, "i");
  const withCur = (label) => [
    re(String.raw`${label}\s*(?:\([^)]{0,10}\))?\s*[:：]?\s*${P}\s*${NUM}`),
    re(String.raw`${label}\s*(?:\([^)]{0,10}\))?[^\d]{0,10}${NUM}\s*${S}`),
  ];
  return {
    currency,
    min,
    max,
    manwon: false,
    own: [...withCur(String.raw`목표\s*주가`), ...withCur(String.raw`(?:target\s*price|\bTP)`)],
    consensus: [
      ...withCur(String.raw`목표\s*주가\s*컨센서스`),
      ...withCur(String.raw`컨센서스\s*목표\s*주가`),
      ...withCur(String.raw`TP\s*\(\s*컨센서스\s*\)`),
      ...withCur(String.raw`consensus\s*target\s*price`),
    ],
  };
}
MARKET_RULES.ch = currencyRules({
  currency: "HKD·CNY",
  prefix: String.raw`HK\$|HKD|CNY|RMB|¥|￥`,
  suffix: String.raw`홍콩\s*달러|HKD|위안|CNY|RMB|元`,
  min: 0,
  max: 100_000,
});
MARKET_RULES.jp = currencyRules({
  currency: "JPY",
  prefix: String.raw`¥|￥|JPY`,
  suffix: String.raw`엔|JPY|円`,
  min: 0,
  max: 10_000_000,
});
MARKET_RULES.eu = currencyRules({
  currency: "EUR·GBP·CHF 등",
  prefix: String.raw`€|EUR|£|GBP|GBp|CHF|SEK|DKK|NOK`,
  suffix: String.raw`유로|EUR|파운드|GBP|GBp|펜스|스위스\s*프랑|CHF|크로나|크로네|SEK|DKK|NOK`,
  min: 0,
  max: 100_000,
});

/** 시장 규칙. 규칙이 없는 시장은 null — 추출하지 않는다. */
function rulesOf(market) {
  return MARKET_RULES[market] ?? null;
}

function matchPrice(patterns, text, rules) {
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    if (m[1] === "-") return null; // "목표주가 -원" = 미제시
    const manwon = rules.manwon && m[2];
    // 국내(만원 단위 규칙)는 "만" 없는 소수를 받지 않는다("3.6원" 같은 오탐 방지).
    if (rules.manwon && !manwon && m[1].includes(".")) continue;
    const raw = Number(m[1].replace(/,/g, ""));
    const n = manwon ? Math.round(raw * 10_000) : raw; // 3.6만원 → 36000 (부동소수 오차 제거)
    if (Number.isFinite(n) && n > rules.min && n < rules.max) return n;
    // 범위 밖이면 다음 패턴으로(기존 해외 추출기와 같은 동작).
  }
  return undefined; // 인정할 값 없음
}

// ── 공개 API ────────────────────────────────────────────────────────────

/** 목표주가 — 자체 목표가 → (해외) 컨센서스. 못 찾으면 null. */
export function extractTargetPrice(text, market = "kr") {
  const t = withoutDisclaimer(text);
  const rules = rulesOf(market);
  if (!t || !rules) return null;
  const own = matchPrice(rules.own, t, rules);
  if (own !== undefined) return own;
  return matchPrice(rules.consensus, t, rules) ?? null;
}

/**
 * 투자의견. `{ head: true }` 면 PDF 앞부분이라 줄 맨 앞 등급 표기까지 인정.
 */
export function extractOpinion(text, { head = false } = {}) {
  const t = withoutDisclaimer(text);
  const m =
    t.match(OPINION_LABEL_RE) ??
    t.match(OPINION_WORD_FIRST_RE) ??
    (head ? t.slice(0, PDF_HEAD_CHARS).match(OPINION_HEAD_RE) : null) ??
    t.match(OPINION_QUALIFIED_LINE_RE);
  return m ? normalizeOpinion(m[1]) : "";
}

export function mentionsTargetPrice(text) {
  return TARGET_MENTION_RE.test(withoutDisclaimer(text));
}
export function mentionsOpinion(text) {
  return OPINION_MENTION_RE.test(withoutDisclaimer(text));
}

const pdfCache = new Map();
/**
 * PDF 텍스트(URL 당 1회). 실패하면 빈 문자열 — 수집 자체는 계속.
 * `headers` 는 세션 쿠키가 필요한 게시판(DS 그누보드 첨부 등)용.
 */
export async function readPdfText(pdfUrl, { headers = {} } = {}) {
  if (!pdfUrl) return "";
  if (pdfCache.has(pdfUrl)) return pdfCache.get(pdfUrl);
  let text = "";
  try {
    const res = await fetch(pdfUrl, { headers: { "User-Agent": UA, ...headers } });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      // pdf-parse v2 는 클래스 API — v1 의 default export 호출 방식이 아니다.
      const parser = new PDFParse({ data: buf });
      text = String((await parser.getText()).text ?? "");
      await parser.destroy();
    }
  } catch {
    text = "";
  }
  pdfCache.set(pdfUrl, text);
  return text;
}

/**
 * 종목 리포트의 opinion·targetPrice 를 C1 순서로 채우고 C2 로 검증한다.
 * items 를 제자리에서 수정. 항목 필드:
 *  - market("kr"|"us", 없으면 옵션 market), category("산업"이면 건너뜀)
 *  - opinion·targetPrice: 목록·API 칸 값(없으면 ""/null)
 *  - opinionFrom: "title" 이면 제목에서 읽은 의견 → C2 검증 생략
 *  - summary·title·bodyText: 본문(상세 페이지 텍스트는 bodyText 로)
 *  - pdfUrl·pdfText: PDF(이미 받은 텍스트가 있으면 pdfText)
 * 옵션 usePdf=false 면 PDF 를 받지 않는다(로그인 필요 등).
 */
export async function enrichResearch(
  items,
  { market: defaultMarket = "kr", usePdf = true, sleepMs = 400, log = console.log } = {},
) {
  // 산업분석 제외(C10), 통화 규칙이 없는 시장 제외(ch·jp 등).
  const targets = items.filter((it) => it.category !== "산업" && rulesOf(it.market ?? defaultMarket));
  let pdfFetched = 0;
  let dropped = 0;
  for (const it of targets) {
    const market = it.market ?? defaultMarket;
    // C7 — 목록 칸·제목 값도 같은 표기로(Not Rated → NR).
    const listedOpinion = it.opinion && it.opinionFrom !== "title" ? normalizeOpinion(it.opinion) : "";
    const listedTarget = it.targetPrice ?? null;
    const titleOpinion = it.opinionFrom === "title" && it.opinion ? normalizeOpinion(it.opinion) : "";
    // 본문·PDF 에서 직접 찾은 값(목록 칸 값과 별개).
    let foundOpinion = "";
    let foundTarget = null;

    const body = `${it.title ?? ""}
${it.summary ?? ""}
${it.bodyText ?? ""}`;
    foundOpinion = extractOpinion(body);
    foundTarget = extractTargetPrice(body, market);
    let opinionMentioned = mentionsOpinion(body);
    let targetMentioned = mentionsTargetPrice(body);

    // 이미 확정됐으면 PDF 불필요: 제목 의견·본문에서 찾은 값·본문에서 확인된 목록 값.
    const opinionOk = Boolean(titleOpinion || foundOpinion || (listedOpinion && opinionMentioned));
    const targetOk = foundTarget != null || (listedTarget != null && targetMentioned);
    if (!opinionOk || !targetOk) {
      let pdf = it.pdfText ?? "";
      if (!pdf && usePdf && it.pdfUrl) {
        const cached = pdfCache.has(it.pdfUrl);
        pdf = await readPdfText(it.pdfUrl);
        if (!cached) {
          pdfFetched++;
          await new Promise((r) => setTimeout(r, sleepMs));
        }
      }
      if (pdf) {
        if (!foundOpinion) foundOpinion = extractOpinion(pdf, { head: true });
        if (foundTarget == null) foundTarget = extractTargetPrice(pdf, market);
        opinionMentioned ||= mentionsOpinion(pdf);
        targetMentioned ||= mentionsTargetPrice(pdf);
      }
    }
    // 등급·목표가를 문서에서 직접 찾았다면 그 자체가 언급이다(라벨 단어가 없는 표기 —
    // 메리츠 "Buy (Maintain)" 등).
    opinionMentioned ||= Boolean(foundOpinion);
    targetMentioned ||= foundTarget != null;

    // 우선순위: 제목 의견 → 목록·API 칸(C2 — 문서에 언급이 있을 때만) → 문서에서 찾은 값.
    let opinion = titleOpinion;
    if (!opinion && listedOpinion) {
      if (opinionMentioned) opinion = listedOpinion;
      else dropped++;
    }
    if (!opinion) opinion = foundOpinion;
    let target = null;
    if (listedTarget != null) {
      if (targetMentioned) target = listedTarget;
      else dropped++;
    }
    if (target == null) target = foundTarget;
    it.opinion = opinion;
    it.targetPrice = target;
  }
  // 임시 필드는 전송 전에 지운다 — 항목을 통째로 보내는 수집기(NH 등)에서 PDF
  // 전문이 서버로 넘어가지 않게(요청 크기 제한·원문 미저장 원칙).
  for (const it of items) {
    delete it.pdfText;
    delete it.bodyText;
    delete it.opinionFrom;
  }
  const withOpinion = targets.filter((it) => it.opinion).length;
  const withTarget = targets.filter((it) => it.targetPrice != null).length;
  log(
    `✔ 투자의견·목표주가 — 의견 ${withOpinion}/${targets.length} · 목표가 ${withTarget}/${targets.length}` +
      ` (PDF ${pdfFetched}건 확인, 본문 언급 없어 버린 목록값 ${dropped}건)`,
  );
  return { withOpinion, withTarget, dropped };
}


/**
 * PDF 본문에서 화면용 짧은 발췌(150자 내외). 한경 수집기의 규칙을 공용으로 뺐다
 * (2026-09-28, DS 수집기가 요약을 전혀 안 채우던 문제 — 감사 5번). 한글 비중이
 * 낮은 줄(표·숫자·영문 헤더)은 버리고 문장 경계에서 자른다.
 */
export function excerptFromPdfText(text, maxLen = 150) {
  const hangulRatio = (l) => {
    const h = (l.match(/[가-힣]/g) || []).length;
    return l.length ? h / l.length : 0;
  };
  const lines = String(text || "").split(String.fromCharCode(10)).map((l) => l.trim()).filter(Boolean);
  const prose = lines.filter((l) => l.length >= 20 && hangulRatio(l) >= 0.4);
  const flat = prose.join(" ").replace(/\s{2,}/g, " ").trim();
  if (!flat) return "";
  if (flat.length <= maxLen) return flat;
  const cut = flat.slice(0, maxLen);
  const boundary = Math.max(cut.lastIndexOf("다."), cut.lastIndexOf("요."), cut.lastIndexOf("함."));
  return (boundary > maxLen * 0.5 ? cut.slice(0, boundary + 1) : cut) + "…";
}
