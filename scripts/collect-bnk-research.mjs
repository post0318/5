/**
 * BNK투자증권 "기업분석" 리포트 수집기 (국내 종목).
 *
 * www.bnkfn.co.kr/research/analysingCompany.jspx — 로그인 없이 평범한 GET 으로
 * 서버렌더 HTML 이 그대로 나온다(오너가 URL 제시, 2026-09). 지금까지 붙인
 * 소스 중 구조가 가장 단순한 축.
 *
 * 제목이 "[종목명/투자의견] 제목" 형식으로 고정돼 있어 종목명과 투자의견을
 * 함께 뽑는다. 종목코드는 목록에 없어 서버 라우트의 이름 검색(corpcode)에
 * 맡긴다(symbol: null 로 보내면 /api/cron/shinhan-research 가 resolveSymbol 로
 * 매핑한다 — 하나·교보 등과 같은 방식).
 *
 * PDF 는 로그인 없이 받아진다: /uploads/{글번호}/1/{파일명}.pdf (실측 확인).
 * 목표주가는 목록에 없어 PDF 에서 뽑는다(국내 표기이므로 "N원" 기준).
 *
 * ⚠️ robots.txt 확인 결과에 관계없이 다른 예외들과 동일 조건을 적용한다 —
 *    개인용·하루 1회·저빈도(CLAUDE.md 참고).
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-bnk-research.mjs
 *   node scripts/collect-bnk-research.mjs --days=90 --dry-run
 */

import { readFileSync } from "node:fs";
import { PDFParse } from "pdf-parse";

function loadEnvLocal() {
  const env = { ...process.env };
  try {
    const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*?)"?\s*$/);
      if (m && (env[m[1]] === undefined || env[m[1]] === "")) env[m[1]] = m[2];
    }
  } catch {
    /* .env.local 없어도 됨 */
  }
  return env;
}
const ENV = loadEnvLocal();
const ARGS = process.argv.slice(2);
const arg = (n) => ARGS.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const DRY_RUN = ARGS.includes("--dry-run");
const DAYS = Number(arg("days")) || 14;
const MAX_PAGES = Number(arg("pages")) || 5;

const LIST_URL = "https://www.bnkfn.co.kr/research/analysingCompany.jspx";
// 산업분석/투자전략(2026-09 추가, 오너 지시 — "한국과 미국 모두 동일하게
// 수집 기반 구축"): 같은 사이트의 형제 게시판(오너가 URL 제시 방식과 동일
// 하게 목록 페이지 링크를 역추적해 확인) — analysingIssue.jspx(업종분석,
// 제목이 기업분석과 똑같은 "[업종명] 헤드라인" 형식이라 같은 TITLE_RE 로
// 파싱 가능), economyAnalyse.jspx(경제분석/투자전략, 대괄호 없는 평문 제목).
const ISSUE_URL = "https://www.bnkfn.co.kr/research/analysingIssue.jspx";
const ECON_URL = "https://www.bnkfn.co.kr/research/economyAnalyse.jspx";
const IMPORT_URL = (
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://macroresearch.vercel.app/api/cron/shinhan-research"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim();
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXCERPT_LEN = 150;
const stripHtml = (s) =>
  String(s ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

/** 제목: "[종목명/투자의견] 나머지" — 의견이 없는 항목(예: "[종목명]")도 허용. */
const TITLE_RE = /^\[([^/\]]+?)(?:\s*\/\s*([^\]]+))?\]\s*(.+)$/;

/** 국내 리포트라 목표주가는 "N원" 표기. */
function extractTargetPrice(text) {
  const m = String(text ?? "").match(/목표\s*주가[^\d]{0,16}([\d,]{4,12})\s*원/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 산업분석 relatedSymbols 계산용 대형주 이름→코드(2026-09-19 추가, 오너
 * 지적 — BNK "반도체" 산업분석 PDF에 삼성전자가 26번 언급되는데도
 * category:"산업"이라 symbol이 항상 null이라서 삼성전자 페이지에서 안
 * 보였음). 전체 종목이 아니라 업종 대표 대형주만 추린다 — 작은 종목까지
 * 다 스캔하면 본문에 스치듯 언급된 것까지 걸려 노이즈가 커진다. BNK 먼저
 * 해보고(오너 지시 — "bnk만 해보고 결정하자") 다른 수집기로 확대할지
 * 결정.
 */
const MAJOR_STOCKS = [
  ["삼성전자", "005930"],
  ["SK하이닉스", "000660"],
  ["LG에너지솔루션", "373220"],
  ["삼성바이오로직스", "207940"],
  ["현대차", "005380"],
  ["기아", "000270"],
  ["셀트리온", "068270"],
  ["POSCO홀딩스", "005490"],
  ["NAVER", "035420"],
  ["카카오", "035720"],
  ["삼성SDI", "006400"],
  ["LG화학", "051910"],
  ["한화에어로스페이스", "012450"],
  ["HD현대중공업", "329180"],
  ["삼성물산", "028260"],
  ["KB금융", "105560"],
  ["신한지주", "055550"],
  ["현대모비스", "012330"],
  ["LG전자", "066570"],
  ["SK이노베이션", "096770"],
  ["두산에너빌리티", "034020"],
  ["한국전력", "015760"],
  ["삼성생명", "032830"],
  ["하나금융지주", "086790"],
  ["크래프톤", "259960"],
  ["한미반도체", "042700"],
  ["에코프로", "086520"],
  ["에코프로비엠", "247540"],
];

/** 본문에서 대형주 이름이 3회 이상 언급되면 "실질적으로 다룬다"고 판단한다
 * (1~2회는 스쳐가는 비교 언급일 수 있어 오탐 방지). 이름 검색으로 종목코드를
 * 추측하는 것과 달리 실제 언급 빈도 기반이라 우연한 오매칭 위험이 없다. */
function findRelatedSymbols(text) {
  const hay = String(text ?? "");
  const found = [];
  for (const [name, code] of MAJOR_STOCKS) {
    const re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
    const count = (hay.match(re) ?? []).length;
    if (count >= 3) found.push(code);
  }
  return found;
}

// 일시적 네트워크 오류(GitHub Actions 러너 쪽 DNS 일시 장애 — 실측 2026-09,
// "getaddrinfo EAI_AGAIN www.bnkfn.co.kr" 로 연속 실패했으나 로컬에서는
// 정상 접속 확인됨)에도 전체 수집이 죽지 않도록 페이지당 재시도를 둔다.
//
// ⚠️ 페이지네이션 버그 수정(오너 지적 2026-09-19 — "삼성전자 bnk 리포트
// 빠진원인먼가?"): `?pageIndex=N` GET 쿼리스트링은 서버가 그냥 무시하고
// 항상 1페이지를 돌려준다(실측 확인 — page1과 "page2"가 완전히 동일한
// 목록이었음). 실제 페이지네이션은 목록 폼(`<form name="listFrm"
// method="post">`, 페이지 링크의 `onclick="fn_search('N')"`)이 POST로
// `curPage` 필드를 보내는 방식이다(실측 — POST curPage=2 로 실제 다른
// 목록 확인됨, 마지막 페이지 476). 즉 이 수집기는 지금까지 매번 최신
// 10여 건만 반복 수집했지 뒤 페이지(오래된 리포트)는 한 번도 못 가져온
// 상태였다 — 그래서 이 브로커가 최근 다루지 않은 종목(삼성전자 등)은
// 실제로 안 다뤘는지, 예전엔 다뤘는데 못 가져온 건지 구분이 안 됐다.
async function fetchPage(page, listUrl = LIST_URL, attempt = 1) {
  try {
    const res =
      page > 1
        ? await fetch(listUrl, {
            method: "POST",
            headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
            body: `curPage=${page}`,
          })
        : await fetch(listUrl, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    if (attempt < 3 && /fetch failed|EAI_AGAIN|ECONNRESET|ETIMEDOUT/i.test(String(err.message ?? err))) {
      console.warn(`  ⚠ 페이지 ${page} 요청 실패(${attempt}회차), 재시도: ${err.message}`);
      await sleep(2000 * attempt);
      return fetchPage(page, listUrl, attempt + 1);
    }
    throw err;
  }
}

function parseItems(html) {
  const items = [];
  for (const row of html.split(/<tr[^>]*>/).slice(1)) {
    const idM = row.match(/viewAction\(this,\s*'(\d+)',\s*'([^']*)',\s*'([^']*)'\)/);
    const titleM = row.match(/viewAction\([^)]*\)[^>]*>([^<]+)</);
    const dateM = row.match(/<td>(\d{4})\.(\d{2})\.(\d{2})<\/td>/);
    const analystM = row.match(/<\/td><td>([^<]{2,12})<\/td>/);
    if (!idM || !titleM || !dateM) continue;
    const tm = stripHtml(titleM[1]).match(TITLE_RE);
    if (!tm) continue;
    items.push({
      id: idM[1],
      date: `${dateM[1]}-${dateM[2]}-${dateM[3]}`,
      title: tm[3].trim(),
      stockName: tm[1].trim(),
      opinion: (tm[2] ?? "").trim(),
      analyst: analystM ? analystM[1].trim() : "",
      // /uploads/{글번호}/1/{파일명} — 목록의 onclick 인자를 그대로 조립.
      pdfUrl: idM[3] ? `https://www.bnkfn.co.kr${idM[2]}/${idM[3]}` : null,
      targetPrice: null,
      category: "기업",
    });
  }
  return items;
}

// analysingIssue.jspx(업종분석) — 제목이 기업분석과 같은 "[업종명] 헤드라인"
// 형식이라 같은 TITLE_RE 재사용, category만 "산업"으로 다르게 태그.
function parseIssueItems(html) {
  const items = [];
  for (const row of html.split(/<tr[^>]*>/).slice(1)) {
    const idM = row.match(/viewAction\(this,\s*'(\d+)',\s*'([^']*)',\s*'([^']*)'\)/);
    const titleM = row.match(/viewAction\([^)]*\)[^>]*>([^<]+)</);
    const dateM = row.match(/<td>(\d{4})\.(\d{2})\.(\d{2})<\/td>/);
    const analystM = row.match(/<\/td><td>([^<]{2,12})<\/td>/);
    if (!idM || !titleM || !dateM) continue;
    const tm = stripHtml(titleM[1]).match(TITLE_RE);
    if (!tm) continue;
    items.push({
      id: idM[1],
      date: `${dateM[1]}-${dateM[2]}-${dateM[3]}`,
      title: tm[3].trim(),
      stockName: tm[1].trim(),
      opinion: "",
      analyst: analystM ? analystM[1].trim() : "",
      pdfUrl: idM[3] ? `https://www.bnkfn.co.kr${idM[2]}/${idM[3]}` : null,
      targetPrice: null,
      category: "산업",
    });
  }
  return items;
}

// economyAnalyse.jspx(경제분석/투자전략) — 대괄호 없는 평문 제목이라 업종
// 라벨을 뽑을 수 없음. 제목 전체를 title 로, stockName 은 "산업"으로 고정.
function parseEconItems(html) {
  const items = [];
  for (const row of html.split(/<tr[^>]*>/).slice(1)) {
    const idM = row.match(/viewAction\(this,\s*'(\d+)',\s*'([^']*)',\s*'([^']*)'\)/);
    const titleM = row.match(/viewAction\([^)]*\)[^>]*>([^<]+)</);
    const dateM = row.match(/<td>(\d{4})\.(\d{2})\.(\d{2})<\/td>/);
    const analystM = row.match(/<\/td><td>([^<]{2,12})<\/td>/);
    if (!idM || !titleM || !dateM) continue;
    items.push({
      id: idM[1],
      date: `${dateM[1]}-${dateM[2]}-${dateM[3]}`,
      title: stripHtml(titleM[1]).trim(),
      stockName: "산업",
      opinion: "",
      analyst: analystM ? analystM[1].trim() : "",
      pdfUrl: idM[3] ? `https://www.bnkfn.co.kr${idM[2]}/${idM[3]}` : null,
      targetPrice: null,
      category: "산업",
    });
  }
  return items;
}

/** PDF 본문을 한 번만 열어 기업분석은 목표주가를, 산업분석은 relatedSymbols
 * 를 뽑는다(둘 다 필요 없으면 굳이 다시 안 엶) — 원문 텍스트 자체는 저장
 * 안 하고 이 두 결과만 남긴다. */
async function analyzePdf(pdfUrl, category) {
  if (!pdfUrl) return { targetPrice: null, relatedSymbols: [] };
  try {
    const res = await fetch(pdfUrl, { headers: { "User-Agent": UA } });
    if (!res.ok) return { targetPrice: null, relatedSymbols: [] };
    const parser = new PDFParse({ data: Buffer.from(await res.arrayBuffer()) });
    const { text } = await parser.getText();
    await parser.destroy();
    return category === "산업"
      ? { targetPrice: null, relatedSymbols: findRelatedSymbols(text) }
      : { targetPrice: extractTargetPrice(text), relatedSymbols: [] };
  } catch {
    return { targetPrice: null, relatedSymbols: [] };
  }
}

console.log(`▶ BNK투자증권 기업분석 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지`);
// 항목 날짜가 'YYYY-MM-DD'(=UTC 자정)라 컷오프도 자정으로 맞춘다.
const cutoff = new Date(new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10));
const collected = [];
let stop = false;
for (let page = 1; page <= MAX_PAGES && !stop; page++) {
  const items = parseItems(await fetchPage(page));
  if (items.length === 0) break;
  for (const it of items) {
    if (new Date(it.date) < cutoff) {
      stop = true;
      break;
    }
    collected.push(it);
  }
  await sleep(400);
}

for (const [listUrl, parser] of [
  [ISSUE_URL, parseIssueItems],
  [ECON_URL, parseEconItems],
]) {
  stop = false;
  for (let page = 1; page <= MAX_PAGES && !stop; page++) {
    const items = parser(await fetchPage(page, listUrl));
    if (items.length === 0) break;
    for (const it of items) {
      if (new Date(it.date) < cutoff) {
        stop = true;
        break;
      }
      collected.push(it);
    }
    await sleep(400);
  }
}

if (collected.length === 0) {
  console.error("✗ 파싱 결과 0건. 페이지 구조가 바뀌었을 수 있음.");
  process.exit(1);
}
console.log(`✔ 파싱 완료: ${collected.length}건`);
console.log(
  "  최근 3건:",
  collected.slice(0, 3).map((i) => `${i.date} ${i.stockName}/${i.opinion} — ${i.title}`),
);

console.log(`▶ 목표주가/관련종목 추출 중 (${collected.length}건)...`);
for (const it of collected) {
  const { targetPrice, relatedSymbols } = await analyzePdf(it.pdfUrl, it.category);
  it.targetPrice = targetPrice;
  it.relatedSymbols = relatedSymbols;
  await sleep(300);
}
console.log(`✔ 목표주가 ${collected.filter((i) => i.targetPrice != null).length}/${collected.length}건`);
console.log(
  `✔ 관련종목 태그됨 ${collected.filter((i) => i.relatedSymbols?.length > 0).length}건`,
);

if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

// 종목코드는 목록에 없어 서버의 이름 검색(corpcode)에 맡긴다.
const items = collected.map((it) => ({
  id: it.id,
  date: it.date,
  title: it.title,
  stockName: it.stockName,
  symbol: null,
  analyst: it.analyst,
  opinion: it.opinion,
  targetPrice: it.targetPrice,
  summary: "",
  pdfUrl: it.pdfUrl,
  views: null,
  category: it.category,
  relatedSymbols: it.relatedSymbols,
}));

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;
const up = await fetch(IMPORT_URL, {
  method: "POST",
  headers,
  body: JSON.stringify({ items, source: "BNK투자증권" }),
});
const upBody = await up.text();
if (!up.ok) {
  console.error(`✗ 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
  process.exit(1);
}
console.log(`\n✔ 앱 전송 완료: ${upBody}`);
