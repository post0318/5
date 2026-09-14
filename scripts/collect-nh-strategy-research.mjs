/**
 * NH투자증권 "투자전략"(rsh_ppr_dit_cd=02)·"FICC"(04)·"자산관리솔루션"(05)·
 * "모닝미팅브리프"(06) 게시판 수집기 — 전부 종목 무관(category:"산업").
 *
 * 기존 두 NH 수집기(collect-nh-research.mjs=01 기업/산업분석,
 * collect-nh-overseas-research.mjs=03 해외주식+01)와 같은 TR(H3211)인데
 * 게시판 코드만 다르다 — 오너가 NH 리서치 포털 스크린샷을 보여줘서 좌측
 * 메뉴(모닝미팅브리프/투자전략/기업·산업분석/FICC/해외주식/자산관리솔루션)
 * 전체를 확인, `boardList.action?rsh_ppr_dit_cd=01` 페이지의 메뉴 링크에서
 * 나머지 4개 코드를 역추적했다(2026-09).
 *
 * 응답의 `rsh_ppr_ser_cd_nm` 필드가 이미 항목별 성격을 어느 정도 알려준다
 * (실측: 02 게시판은 "시황"/"전략"이 섞여 있고, 06은 전부 "모닝브리핑").
 * 다만 이 필드를 그대로 topic 매핑에 쓰지 않고 stockName에 실어 보내
 * classifyResearchTopic()의 기존 키워드 판정에 맡긴다 — 예를 들어 02
 * 게시판의 "[금요일에 미리 보는 주간 투자전략]"은 ser_cd_nm이 "전략"이지만
 * 제목에 "주간"이 있어 시황으로 가는 게 맞다(오너 지시 — "NH투자증권
 * 투자전략은 투자전략으로 분류하나 모닝, 위클리, 주간 등 특정 단어가
 * 포함되면 시황으로 분류").
 *
 * 시장 분류:
 *  - 06(모닝미팅브리프): 전부 시황·해외 취급(오너 지시 — "모닝브리프는
 *    미국 시황이다") — market:"us" 고정.
 *  - 04(FICC): 오너 지시 — "FICC는 해외투자전략으로 분류" — market:"us"
 *    고정(개별 항목이 국내 채권 얘기여도 게시판 성격상 일괄 적용, 다른
 *    소스의 source+market 강제 분류와 동일한 트레이드오프).
 *  - 02(투자전략)·05(자산관리솔루션): 국가 신호 키워드로 판정(미국 신호 →
 *    us, 타국 명시 → 스킵, 신호 없음 → kr 기본값) — 다른 신규 수집기
 *    (하나 글로벌 산업분석, 한국투자 전략/이슈)와 동일한 방식.
 *
 * ⚠️ www.nhsec.com/robots.txt 는 `Disallow: /` — 다른 NH 수집기와 동일
 *    조건(개인용·로컬 실행·저빈도)으로 오너 승인(CLAUDE.md 참조).
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-nh-strategy-research.mjs
 *   node scripts/collect-nh-strategy-research.mjs --days=30 --pages=10 --dry-run
 */

import { readFileSync } from "node:fs";
import { readPdfText } from "./lib/us-research-extract.mjs";

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
const MAX_PAGES = Number(arg("pages")) || 10;

const AJAX_URL = "https://www.nhsec.com/research/boardCommonTrAjax.action";
const PAGE_SIZE = 20; // 서버가 이보다 많이 요청해도 20건으로 잘라 응답(다른 NH 수집기와 동일 실측)
const IMPORT_URL = (
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://5-topaz-five.vercel.app/api/cron/shinhan-research"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim();
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BOARDS = [
  { ditCd: "02", label: "투자전략", forceMarket: null },
  { ditCd: "04", label: "FICC", forceMarket: "us" },
  { ditCd: "05", label: "자산관리솔루션", forceMarket: null },
  { ditCd: "06", label: "모닝미팅브리프", forceMarket: "us" },
];

function isoDate(yyyymmdd) {
  const m = String(yyyymmdd).match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

const GENERIC_BRACKET_RE = /^\[([^\]]+)\]\s*(.+)$/;
const DECOR_RE = /^◆\s*|\s*◆$/g;
function decodeEntities(s) {
  return s
    .replace(/&lsquo;|&rsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// 목록 응답에 발췌가 아예 없어(다른 NH 수집기와 동일 문제, 실측으로 발견돼
// collect-nh-overseas-research.mjs 에도 이미 추가함) PDF 본문에서 뽑는다.
const EXCERPT_LEN = 150;
function excerptFromPdfText(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const anchor = lines.findIndex((l) => /Note\s*[│|]/.test(l));
  const bodyLines = anchor >= 0 ? lines.slice(anchor + 3) : lines.slice(4);
  const flat = bodyLines
    .filter((l) => l.length >= 10)
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!flat) return "";
  if (flat.length <= EXCERPT_LEN) return flat;
  const cut = flat.slice(0, EXCERPT_LEN);
  const boundary = Math.max(cut.lastIndexOf("다."), cut.lastIndexOf("요."), cut.lastIndexOf("함."));
  return (boundary > EXCERPT_LEN * 0.5 ? cut.slice(0, boundary + 1) : cut) + "…";
}

const NON_US_RE =
  /중국|차이나|China|일본|엔화|엔캐리|Japan|유럽|Europe|베트남|Vietnam|인도(?!네시아)|India\b|신흥국|이머징|Emerging|브라질|Brazil|대만|Taiwan/i;
const US_HINT_RE = /미국|\bUS\b|나스닥|Nasdaq|S&P|다우|연준|\bFed\b|FOMC|월가|Wall Street|Global\s?Markets/i;
function classifyMarket(text) {
  if (NON_US_RE.test(text)) return null;
  if (US_HINT_RE.test(text)) return "us";
  return "kr";
}

async function fetchPage(ditCd, cursor) {
  const body = new URLSearchParams({
    trName: "H3211",
    output: "json",
    isNext: cursor ? "true" : "false",
    rsh_ppr_dit_cd: ditCd,
    rsh_ppr_ser_cd: "",
    rmt_cnt: String(PAGE_SIZE),
    rsh_ppr_no: cursor?.no ?? "",
    rsh_ppr_dru_dt_st: cursor?.date ?? "",
    rsh_ppr_dru_tm_st: cursor?.time ?? "",
    rsh_ppr_dru_dt_ed: "",
    sch_hdn_ipt_cts: "",
  });
  const res = await fetch(AJAX_URL, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Referer: `https://www.nhsec.com/research/boardList.action?rsh_ppr_dit_cd=${ditCd}`,
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = new TextDecoder("euc-kr").decode(await res.arrayBuffer());
  return JSON.parse(text);
}

function parseRows(json) {
  const status = json?.DATA?.STATUS?.CODE;
  if (status !== "T000") throw new Error(`TR 실패: ${json?.DATA?.STATUS?.MSG ?? status}`);
  return json?.DATA?.RESPONSE?.H3211OutBlock2?.ROW ?? [];
}

console.log(`▶ NH투자증권 투자전략/FICC/자산관리솔루션/모닝미팅브리프 수집: 최근 ${DAYS}일`);
const cutoff = new Date(new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10));
const collected = [];

for (const board of BOARDS) {
  let cursor = null;
  let stop = false;
  for (let page = 1; page <= MAX_PAGES && !stop; page++) {
    const json = await fetchPage(board.ditCd, cursor);
    const rows = parseRows(json);
    if (rows.length === 0) break;
    for (const r of rows) {
      const date = isoDate(r.rsh_ppr_dru_dt);
      if (date && new Date(date) < cutoff) {
        stop = true;
        break;
      }
      const rawTitle = decodeEntities(String(r.rsh_ppr_til_cts ?? "")).replace(DECOR_RE, "").trim();
      const bm = rawTitle.match(GENERIC_BRACKET_RE);
      let stockName = bm ? bm[1].trim() : r.rsh_ppr_ser_cd_nm || board.label;
      const title = bm ? bm[2].trim() : rawTitle;
      // FICC 게시판은 세부 라벨(리츠/채권/크레딧 등)이 "FICC" 단어 자체를
      // 안 담고 있는 경우가 많아(예: "[원자재(에너지)/Note]") 키워드가
      // 사라지지 않게 항상 접두어로 붙인다 — 오너 지시("FICC는 해외투자
      // 전략으로 분류")를 어떤 세부 라벨이 와도 지키기 위함.
      if (board.ditCd === "04") stockName = `FICC · ${stockName}`;

      const market = board.forceMarket ?? classifyMarket(`${stockName} ${title}`);
      if (!market) continue; // 미국 외 국가 명시 — 이 수집기는 미국/국내 외엔 다루지 않음

      collected.push({
        id: r.rsh_ppr_no,
        date,
        title: title || rawTitle,
        stockName,
        analyst: r.rsh_ppr_dru_emp_fnm ?? "",
        market,
        pdfUrl: r.hpge_fle_url_cts || null,
      });
    }
    const last = rows[rows.length - 1];
    cursor = { no: last.rsh_ppr_no, date: last.rsh_ppr_dru_dt, time: last.rsh_ppr_dru_tm };
    await sleep(400);
  }
}

if (collected.length === 0) {
  console.log("○ 최근 기간 내 항목 없음.");
  process.exit(0);
}
console.log(`✔ 파싱 완료: ${collected.length}건`);
console.log(
  "  최근 5건:",
  collected.slice(0, 5).map((i) => `${i.date} [${i.market}] [${i.stockName}] ${i.title}`),
);

console.log(`▶ PDF 본문 발췌 중...`);
const excerptCache = new Map();
let excerptFailCount = 0;
for (const it of collected) {
  if (!it.pdfUrl) continue;
  if (!excerptCache.has(it.pdfUrl)) {
    const text = await readPdfText(it.pdfUrl);
    excerptCache.set(it.pdfUrl, excerptFromPdfText(text));
    await sleep(400);
  }
  it.summary = excerptCache.get(it.pdfUrl);
  if (!it.summary) excerptFailCount++;
}
console.log(`✔ 발췌 완료 (실패 ${excerptFailCount}건, PDF ${excerptCache.size}개)`);

if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

const byMarket = new Map();
for (const it of collected) {
  if (!byMarket.has(it.market)) byMarket.set(it.market, []);
  byMarket.get(it.market).push(it);
}

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;

for (const [market, group] of byMarket) {
  const payload = group.map((it) => ({
    id: it.id,
    date: it.date,
    title: it.title,
    stockName: it.stockName,
    symbol: null,
    analyst: it.analyst,
    opinion: "",
    targetPrice: null,
    summary: it.summary || "",
    pdfUrl: it.pdfUrl,
    views: null,
    category: "산업",
  }));
  const up = await fetch(IMPORT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ items: payload, source: "NH투자증권", market }),
  });
  const upBody = await up.text();
  if (!up.ok) {
    console.error(`✗ 앱 전송 실패(market=${market}) HTTP ${up.status}: ${upBody.slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`\n✔ 앱 전송 완료(market=${market}, ${payload.length}건): ${upBody}`);
}
