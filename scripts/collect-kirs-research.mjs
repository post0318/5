/**
 * 한국IR협의회 기업리서치센터(www.kirs.or.kr) 기업분석 보고서 수집기.
 *
 * 지금까지 한경 컨센서스 경유(source "한국IR협의회")로만 들어오던 보고서를
 * 발간처에서 직접 수집한다(오너 결정 2026-09-25). source 문자열을 한경 경유
 * 때와 똑같이 둬서 화면·dedupe 가 같은 증권사로 취급한다.
 *
 * ── 조사 근거(실측 2026-09-25) ─────────────────────────────────────
 * - robots.txt: `User-agent: Yeti` 그룹만 있고 일반 UA 제한 없음. 로그인·쿠키
 *   불필요, 응답 UTF-8 서버렌더 HTML.
 * - 게시판 두 곳(구조 동일, `<table class="board_list_table04">`, 10건/페이지):
 *     인소싱  /research/research22_1.html — 협의회 애널리스트가 쓰는 본 보고서
 *             (한경에 올라오는 것). 종목 칸 "코스메카코리아 (241710)".
 *     아웃소싱 /research/research.html — 외부 평가기관(서울평가정보·NICE평가정보
 *             등) 기술분석보고서. 종목 칸 "아이엘로보틱스(403810)"(공백 없음),
 *             작성자 칸은 기관명.
 *   공통 쿼리: ?dbname=research&page=N&mode=search&area=&keyword=&start_date=
 *   &end_date=&chk_status=&tr_type=
 * - 각 행 PDF 아이콘의 `onclick='add_hit(N)'` 숫자가 글번호 — id 로 쓴다
 *   (게시판별 네임스페이스 `in:N`/`out:N`). **add_hit(= /function.php) 은
 *   조회수를 올리는 호출이라 절대 부르지 않는다.**
 * - PDF: 목록 href 직링크(로그인 불필요). 파일명에 한글·★·공백·괄호가 그대로
 *   있어 `encodeURI` 로 인코딩해 요청·저장한다(브라우저에서도 그대로 열림).
 * - TLS: www·w4 서버가 중간 인증서(GlobalSign GCC R6 AlphaSSL CA 2025)를
 *   보내지 않아 Node fetch 가 UNABLE_TO_VERIFY_LEAF_SIGNATURE 로 실패한다
 *   (curl/브라우저는 AIA 로 보완해 열림). 그 중간 인증서(공개 인증서, 만료
 *   2027-05-21, 루트 GlobalSign R6 는 Node 번들에 있음)를 아래에 넣어 기본 CA
 *   목록에 더한다 — 검증을 끄는 게 아니라 체인만 보완. Node 24+ 필요
 *   (`tls.setDefaultCACertificates`). 인증서가 바뀌면 AIA
 *   (http://secure.globalsign.com/cacert/…crt)에서 다시 받아 교체.
 *
 * ── 저작권·저장 범위 ────────────────────────────────────────────────
 * PDF 말미에 "무단 복제 및 배포할 수 없습니다" 문구가 있다 — 그래서 원문·
 * 전체 본문은 저장하지 않고, 1쪽 요약 bullet("■ …") 앞부분 300자 내외 발췌와
 * PDF 링크만 저장한다(다른 증권사의 "요약 발췌만" 정책과 동일).
 * 투자의견·목표주가는 원래 없다("매수 및 매도 추천 의견은 포함하고 있지
 * 않습니다") → opinion "", targetPrice null.
 *
 * 분류: 전부 category "기업", market "kr", symbol = 괄호 안 6자리 코드(영문 혼합 신규 코드 포함).
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-kirs-research.mjs
 *   node scripts/collect-kirs-research.mjs --days=30 --dry-run
 */

import { readFileSync } from "node:fs";
import { isCommonExcludedContent } from "./lib/exclude-filters.mjs";
import tls from "node:tls";

// 서버가 빠뜨리는 중간 인증서(위 주석 참고).
const KIRS_INTERMEDIATE_PEM = `-----BEGIN CERTIFICATE-----
MIIFjTCCA3WgAwIBAgIRAIN9TriekS/nLK07x2kt3CAwDQYJKoZIhvcNAQELBQAw
TDEgMB4GA1UECxMXR2xvYmFsU2lnbiBSb290IENBIC0gUjYxEzARBgNVBAoTCkds
b2JhbFNpZ24xEzARBgNVBAMTCkdsb2JhbFNpZ24wHhcNMjUwNTIxMDIzNjUyWhcN
MjcwNTIxMDAwMDAwWjBVMQswCQYDVQQGEwJCRTEZMBcGA1UEChMQR2xvYmFsU2ln
biBudi1zYTErMCkGA1UEAxMiR2xvYmFsU2lnbiBHQ0MgUjYgQWxwaGFTU0wgQ0Eg
MjAyNTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAJ/oiu0Bviq52UUE
ADbFWmgu3rC7KDSMoorLN1Wd03McG3Z1aP71DlPCE33838r72Dfuj5M9LXfiQLJp
Au6MwNExmKOzothw4x0zGf5oBYyrCMGm3fBpLPafwYQ3MchBOWMTbf83rKUPLH48
KCJ0MnU8GUl8oA/J81wIvbbKPuNrFf6hvJDccjzc4NyxLz3A89zjV2g5whCg5O0u
9YX4Zxk9JHuc/LvllOJO4waAYLjbWBJkz3rV3ts1SmSYnJqmyRTIjXwQgRvhEYqt
DbRskt0W7M6cPwCze3GTBN2UHNpHkMs3YmVxku68I0aOQn5+uz//fDROP3z1Z/7I
APteRtECAwEAAaOCAV8wggFbMA4GA1UdDwEB/wQEAwIBhjAdBgNVHSUEFjAUBggr
BgEFBQcDAQYIKwYBBQUHAwIwEgYDVR0TAQH/BAgwBgEB/wIBADAdBgNVHQ4EFgQU
xbSTj28r3B5Iv7cQMIXO0bK7SC0wHwYDVR0jBBgwFoAUrmwFo5MT4qLn4tcc1sfw
f8hnU6AwewYIKwYBBQUHAQEEbzBtMC4GCCsGAQUFBzABhiJodHRwOi8vb2NzcDIu
Z2xvYmFsc2lnbi5jb20vcm9vdHI2MDsGCCsGAQUFBzAChi9odHRwOi8vc2VjdXJl
Lmdsb2JhbHNpZ24uY29tL2NhY2VydC9yb290LXI2LmNydDA2BgNVHR8ELzAtMCug
KaAnhiVodHRwOi8vY3JsLmdsb2JhbHNpZ24uY29tL3Jvb3QtcjYuY3JsMCEGA1Ud
IAQaMBgwCAYGZ4EMAQIBMAwGCisGAQQBoDIKAQMwDQYJKoZIhvcNAQELBQADggIB
AB/uvBuZf4CiuSahwiXn4geF52roAH+6jxsEPTXTfb7bbeMDXsYgRRsOTNA70ruZ
Tnz5DfFMuBhNoFhIFb0qR1izdy6VkdKOqFPNF2dOFI1EcnY9l2ory9mrzHqVbrL4
vzUd17FLUVyjTVU7PAv4nxyhnO1GTeT83YlrdRF31NyR6bvZVTEERHmpbWSgeveJ
LRtaMzlGWiLZ8IwkH7o6GH3jp/KPtDW4Npu8w64HrRZdN2pqQhi7+YKwfHM7H+2U
dM1BGN0sjOWMVbMSB9MtCsleS2Mb7TRZEbOHxECJLLIluQypZr7Pol3+hAqrhyKI
k+6y+Da0NeDuWxW59Ku4NvClqW1UFX1SpfNGhzVfp/CH+vPM1tySomx2jE0EnYZu
GwVucXPBsp5nUWqUV9+143glVuS7GTg9hFPjNBInn17HbCoIIQIOzj5Vd9bK3A9U
GxXNpwenDHEalCsD/4eQYDHPhFE7sNe0D/OXu+FAM02VZkARx37Jp4bDdujvgL9P
vZPR3wThvDN1CTU8Bc3xea3yKFAraKcPZLkhReQUAm2VpR+HSJRPlUpYizlF9WkL
h3KcAVCBJWvnOkVwxyU5QJMcnwW95JlOtx+9100GL99jHE5rs3gXp7F4bg8H01QT
9jVOhBBmQ7nQoXuwI0tqal2QUqZz3eeu62CU7xBwtfYR
-----END CERTIFICATE-----`;

if (typeof tls.setDefaultCACertificates !== "function") {
  console.error("✗ Node 24 이상 필요(tls.setDefaultCACertificates) — kirs.or.kr 중간 인증서 보완용.");
  process.exit(1);
}
tls.setDefaultCACertificates([...tls.getCACertificates("default"), KIRS_INTERMEDIATE_PEM]);

// 인증서 설정 뒤에 불러와야 PDF 요청(전역 fetch)에도 적용된다.
const { readPdfText } = await import("./lib/research-extract.mjs");

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
const DRY_RUN = ARGS.includes("--dry-run");
// 발간이 월 20건 안팎이라 기본 7일.
const DAYS = Number(ARGS.find((a) => a.startsWith("--days="))?.split("=")[1]) || 7;
const MAX_PAGES = 20;

const IMPORT_URL = (
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://macroresearch.vercel.app/api/cron/total-research"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim();
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const SLEEP_MS = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SOURCE = "한국IR협의회";
const BOARDS = [
  { key: "in", label: "인소싱(기업분석)", path: "/research/research22_1.html" },
  { key: "out", label: "아웃소싱(기술분석)", path: "/research/research.html" },
];
const SUMMARY_MAX = 300;

const ROW_RE = /<tr>([\s\S]*?)<\/tr>/g;
const TD_RE = /<td[^>]*>([\s\S]*?)<\/td>/g;
const HREF_RE = /href=['"]([^'"]+\.pdf)['"]/i;
const HIT_RE = /add_hit\((\d+)\)/;
// 종목코드 6자리 — 2024년 이후 신규 상장은 영문 혼합 코드(예: 페스카로 "0015S0").
const STOCK_RE = /^(.+?)\s*\(([0-9][0-9A-Z]{5})\)\s*$/;

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
}
const cellText = (html) => decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

async function fetchPage(board, page) {
  const url = new URL(`https://www.kirs.or.kr${board.path}`);
  const params = {
    dbname: "research",
    page: String(page),
    mode: "search",
    area: "",
    keyword: "",
    start_date: "",
    end_date: "",
    chk_status: "",
    tr_type: "",
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} (${url})`);
  return res.text();
}

function parseRows(html, board) {
  const table = html.match(/<table[^>]*board_list_table04[\s\S]*?<\/table>/)?.[0] ?? "";
  const items = [];
  for (const [, row] of table.matchAll(ROW_RE)) {
    const hit = row.match(HIT_RE);
    const href = row.match(HREF_RE);
    if (!hit || !href) continue;
    const cells = [...row.matchAll(TD_RE)].map((m) => m[1]);
    if (cells.length < 5) continue;
    const stockCell = cellText(cells[0]);
    const title = cellText(cells[1]);
    const analyst = cellText(cells[2]);
    const date = cellText(cells[3]).match(/\d{4}-\d{2}-\d{2}/)?.[0];
    if (!date || !title || isCommonExcludedContent(title, "기업")) continue;
    const sm = stockCell.match(STOCK_RE);
    items.push({
      id: `${board.key}:${hit[1]}`,
      date,
      title,
      stockName: sm ? sm[1].trim() : stockCell,
      symbol: sm ? sm[2] : null,
      analyst,
      opinion: "",
      targetPrice: null,
      summary: "",
      // 한글·★·공백·괄호 경로 → 세그먼트 인코딩. 이미 인코딩된 링크는 한 번 풀고 다시.
      pdfUrl: encodeURI(safeDecodeURI(decodeEntities(href[1]))),
      views: null,
      category: "기업",
      board: board.key,
    });
  }
  return items;
}

function safeDecodeURI(s) {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

// PDF 표지 앞 면책 bullet("■ 본 보고서는 …") 등 요약이 아닌 bullet.
const DISCLAIMER_RE = /보고서는|보고서의|요약영상|텔레그램|문의는|추천\s*의견|무단\s*복제/;
const HANGUL = /[가-힣]/;

/** PDF 텍스트에서 요약 bullet 앞부분 SUMMARY_MAX 자 내외 발췌(원문 전체 저장 금지). */
function extractSummary(text) {
  if (!text) return "";
  const clean = text.replace(/\u0000/g, "").replace(/[ \t ]+/g, " ");
  const parts = clean.split("■").slice(1);
  const bullets = [];
  for (const part of parts) {
    // bullet 은 다음 페이지 구분자에서 끝낸다.
    const body = part.split(/\n\s*--\s*\d+\s+of\s+\d+\s*--/)[0];
    const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
    let joined = "";
    for (const l of lines) {
      // PDF 줄바꿈이 한글 단어 중간에서 끊기는 경우가 많아 한글-한글 사이는 붙인다.
      if (!joined) joined = l;
      else if (HANGUL.test(joined.slice(-1)) && HANGUL.test(l[0])) joined += l;
      else joined += " " + l;
    }
    joined = joined.trim();
    if (!joined || DISCLAIMER_RE.test(joined)) continue;
    bullets.push(joined);
    if (bullets.join(" ").length >= SUMMARY_MAX) break;
  }
  const all = bullets.join(" ");
  if (all.length <= SUMMARY_MAX) return all;
  const cut = all.slice(0, SUMMARY_MAX);
  const sp = cut.lastIndexOf(" ");
  return (sp > SUMMARY_MAX * 0.7 ? cut.slice(0, sp) : cut).trim() + "…";
}

console.log(`▶ 한국IR협의회 기업리서치 수집(${BOARDS.map((b) => b.label).join("·")}): 최근 ${DAYS}일`);
const cutoff = new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10);

const collected = [];
for (const board of BOARDS) {
  const seen = new Set();
  let count = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const rows = parseRows(await fetchPage(board, page), board);
    await sleep(SLEEP_MS);
    const fresh = rows.filter((r) => !seen.has(r.id));
    if (fresh.length === 0) break; // 마지막 페이지를 넘기면 같은 목록이 반복된다.
    for (const r of fresh) seen.add(r.id);
    const inRange = fresh.filter((r) => r.date >= cutoff);
    collected.push(...inRange);
    count += inRange.length;
    if (inRange.length < fresh.length) break; // 최신순 — 기간 밖이 나오면 끝.
  }
  console.log(`  ${board.label}: ${count}건`);
}

if (collected.length === 0) {
  // 발간이 드물어 기간 안 0건일 수 있다 — 구조 변경과 구분하려고 경고만.
  console.warn(`⚠ 최근 ${DAYS}일 수집 0건(발간 없음 또는 페이지 구조 변경).`);
  process.exit(0);
}

console.log(`▶ PDF 요약 발췌 중 — ${collected.length}건...`);
for (const it of collected) {
  it.summary = extractSummary(await readPdfText(it.pdfUrl));
  await sleep(SLEEP_MS);
}

for (const i of collected) {
  console.log(`  [${i.id}] ${i.date} ${i.stockName}(${i.symbol ?? "-"}) — ${i.title} [${i.analyst}]`);
  console.log(`      요약(${i.summary.length}자): ${i.summary || "(없음)"}`);
}
const withCode = collected.filter((i) => i.symbol).length;
const withSummary = collected.filter((i) => i.summary).length;
console.log(`✔ 파싱 완료: ${collected.length}건 · 종목코드 ${withCode}건 · 요약 ${withSummary}건`);

if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;

const items = collected.map((it) => ({
  id: it.id,
  date: it.date,
  title: it.title,
  stockName: it.stockName,
  symbol: it.symbol,
  analyst: it.analyst,
  opinion: it.opinion,
  targetPrice: it.targetPrice,
  summary: it.summary,
  pdfUrl: it.pdfUrl,
  views: it.views,
  category: it.category,
  // 원 게시판(사이트 메뉴) — 대조·검수용. it.board 는 게시판 key(in/out).
  board: `한국IR협의회 > ${BOARDS.find((b) => b.key === it.board)?.label ?? it.board}(${BOARDS.find((b) => b.key === it.board)?.path ?? it.board})`,
}));
const up = await fetch(IMPORT_URL, {
  method: "POST",
  headers,
  body: JSON.stringify({ items, source: SOURCE, market: "kr" }),
});
const upBody = await up.text();
if (!up.ok) {
  console.error(`✗ 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
  process.exit(1);
}
console.log(`✔ 앱 전송 완료 (${items.length}건): ${upBody}`);
