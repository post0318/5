/**
 * 원문 HTML 에서 손익계산서 표를 찾아 "창(window)"만 잘라낸다.
 *
 * 거친 휴리스틱이면 충분하다 — 표를 읽는 건 모델이고, 여기서는 토큰을 줄이는 게 목적이다.
 *  1) "STATEMENTS OF OPERATIONS / INCOME / EARNINGS / PROFIT OR LOSS", "INCOME STATEMENTS" 제목 위치를 모두 찾는다
 *     (목차에도 같은 제목이 있으므로 후보가 여럿).
 *  2) 각 제목 뒤 첫 <table> 을 후보로 잡고, 천 단위 콤마 숫자 개수 + "per share"·"net income" 같은
 *     손익계산서 표지어로 점수를 매겨 가장 높은 표를 고른다.
 *  3) 제목 ~ 표 끝을 잘라 태그 속성·서식을 걷어낸 간소화 HTML(모델 입력)과
 *     태그를 뺀 평문(검증기가 숫자 존재 여부를 확인하는 기준)을 함께 돌려준다.
 */

const GAP = String.raw`(?:\s|&nbsp;|&#160;|&#xa0;|<[^>]{0,400}>)+`;
const HEADING_RES = [
  new RegExp(String.raw`STATEMENTS?${GAP}OF${GAP}(?:CONSOLIDATED${GAP})?(?:OPERATIONS|INCOME|EARNINGS|PROFIT${GAP}OR${GAP}LOSS|COMPREHENSIVE${GAP}(?:INCOME|LOSS))`, "gi"),
  new RegExp(String.raw`INCOME${GAP}STATEMENTS?`, "gi"),
];

const ENTITY = { "&nbsp;": " ", "&#160;": " ", "&#xa0;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'" };

export function decodeEntities(s) {
  return s
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos);|&#160;|&#xa0;|&#39;/gi, (m) => ENTITY[m.toLowerCase()] ?? m)
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

/** 태그를 모두 빼고 공백을 하나로 — 검증기의 기준 텍스트 */
export function toPlainText(html) {
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[\s ]+/g, " ")
    .trim();
}

/** 표 구조(table/tr/td/th, colspan/rowspan)만 남긴 간소화 HTML — 모델 입력 */
export function simplifyHtml(html) {
  let s = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<ix:header>[\s\S]*?<\/ix:header>/gi, " ");
  s = s.replace(/<(\/?)([a-zA-Z][\w:.-]*)([^>]*)>/g, (_, close, name, attrs) => {
    const tag = name.toLowerCase();
    if (["table", "tr", "td", "th"].includes(tag)) {
      if (close) return `</${tag}>`;
      const keep = [];
      const cs = /colspan\s*=\s*["']?(\d+)/i.exec(attrs);
      const rs = /rowspan\s*=\s*["']?(\d+)/i.exec(attrs);
      if (cs && cs[1] !== "1") keep.push(`colspan=${cs[1]}`);
      if (rs && rs[1] !== "1") keep.push(`rowspan=${rs[1]}`);
      return `<${tag}${keep.length ? " " + keep.join(" ") : ""}>`;
    }
    if (["p", "div", "br", "li", "h1", "h2", "h3", "h4", "h5", "h6"].includes(tag)) return "\n";
    return ""; // span, font, ix:nonFraction 등은 내용만 남긴다
  });
  s = decodeEntities(s)
    .replace(/[ \t ]+/g, " ")
    .replace(/<(td|th)([^>]*)>\s+/g, "<$1$2>")
    .replace(/\s+<\/(td|th)>/g, "</$1>")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .replace(/>\s+</g, "><")
    // 빈 행(모든 칸이 빈 서식용 행) 제거
    .replace(/<tr>(?:<t[dh][^>]*><\/t[dh]>)*<\/tr>/g, "");
  return s.trim();
}

function findTableEnd(html, start) {
  const re = /<(\/?)table\b[^>]*>/gi;
  re.lastIndex = start;
  let depth = 0;
  let m;
  while ((m = re.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return -1;
}

function scoreTable(text) {
  const bigNums = (text.match(/\d{1,3}(?:,\d{3})+/g) ?? []).length;
  let score = bigNums;
  if (/per\s+(?:common\s+)?share/i.test(text)) score += 20;
  if (/net\s+(?:income|loss|earnings)|profit\s+for\s+the/i.test(text)) score += 20;
  if (/comprehensive/i.test(text) && !/per\s+share/i.test(text)) score -= 40; // 포괄손익계산서만 있는 표는 감점
  if (bigNums < 8) score -= 100; // 목차·색인 표
  return score;
}

/**
 * @param {string} html 원문 전체
 * @returns {{ windowHtml: string; windowText: string; heading: string; rawStart: number; rawEnd: number; score: number } | null}
 */
export function locateIncomeStatement(html) {
  const candidates = [];
  for (const re of HEADING_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(html))) {
      const tStart = html.slice(m.index, m.index + 30000).search(/<table\b/i);
      if (tStart < 0) continue;
      const tableStart = m.index + tStart;
      const tableEnd = findTableEnd(html, tableStart);
      if (tableEnd < 0) continue;
      const tableText = toPlainText(html.slice(tableStart, tableEnd));
      candidates.push({
        headingStart: m.index,
        heading: toPlainText(m[0]),
        tableStart,
        tableEnd,
        score:
          scoreTable(tableText) +
          // 문장 속 소문자 언급("... in the consolidated statements of operations")보다 제목(대문자·Title Case)을 우선
          (/^[A-Z]/.test(m[0]) && /[A-Z]\w*\s*$/.test(toPlainText(m[0])) ? 15 : -15) +
          (tStart > 15000 ? -10 : 0),
      });
    }
  }
  if (!candidates.length) return null;
  // 점수 최고, 같으면 문서 앞쪽(본문 재무제표가 주석 재게시보다 먼저 나옴)
  // 같은 표를 가리키는 제목이 여럿이면(목차 항목 + 실제 제목) 표에 가장 가까운 제목
  candidates.sort((a, b) => b.score - a.score || a.tableStart - b.tableStart || b.headingStart - a.headingStart);
  const best = candidates[0];
  if (best.score < 0) return null;
  // 제목 바로 위 회사명 등 조금 포함, 제목과 표 사이의 단위 문구("(In millions, ...)")는 자연히 포함된다
  // 태그 중간에서 자르지 않도록 제목 300자 앞의 다음 "<" 에서 시작
  const rawStart = Math.max(0, html.indexOf("<", Math.max(0, best.headingStart - 300)));
  const rawEnd = best.tableEnd;
  const raw = html.slice(rawStart, rawEnd);
  return {
    windowHtml: simplifyHtml(raw),
    windowText: toPlainText(raw),
    heading: best.heading,
    rawStart,
    rawEnd,
    score: best.score,
  };
}
