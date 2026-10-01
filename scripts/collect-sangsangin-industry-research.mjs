/**
 * 상상인증권 "산업리포트"(CM0338)·"주식시장"(CM0078) 수집기 — 산업분석/
 * 투자전략/시황 전용, 종목 무관(category:"산업", symbol 항상 null).
 *
 * 오너 지적(2026-09) — "상상인증권은? 산업리포트가 버젓이 공개하는데" +
 * "투자전략도 있고" — 기존 collect-sangsangin-research.mjs(기업리포트,
 * CM0079)와 같은 내부 API(POST /notice/getNoticeList)를 cmsCd만 바꿔
 * 재사용한다. 페이지(research/industryReport/industryReportView,
 * research/stockMarket/stockMarketView)가 로드하는 정적 JS 번들
 * (/static/js/research/{보드}/{보드}.js)에서 cmsCd 값을 역추적해 확인:
 *   - industryReport → CM0338 (868건, 실측) — STOCK_NM 에 이미 업종명이
 *     깔끔히 들어있다("엔터_레저"/"소재"/"화장품"/"조선" 등) — 브라켓 파싱
 *     불필요, 그대로 stockName 으로 쓴다.
 *   - stockMarket    → CM0078 (2,532건, 실측) — STOCK_NM 은 전부 "시장전체"
 *     (구분 안 됨)라 제목의 "[라벨] 헤드라인" 브라켓을 라벨로 뽑는다(예:
 *     "[상상인 US Monitor] 옵션 시장이...", "[채권전략] AI CAPEX..."). 이미
 *     classifyResearchTopic() 의 MARKET_CONDITION_STOCKNAMES 에 있는
 *     "상상인 US Monitor" 라벨과 그대로 맞아떨어진다. 브라켓이 없으면
 *     "시장"(수집기 공통 generic 라벨 관례)으로 정규화.
 *
 * PDF: 기업리포트와 동일한 규칙적 경로(`/_upload/attFile/{cmsCd}/
 * {cmsCd}_{NT_NO}_1.pdf`, 로그인 없이 200 확인). 목표주가·투자의견은 이
 * 카테고리에선 추출을 건너뛴다(다른 산업분석 수집기와 동일 이유 — 특정
 * 종목 얘기가 아니므로).
 *
 * market: 두 게시판 모두 상상인 리서치센터의 국내(한국어) 관점 코멘터리라
 * (미국 자산 얘기도 "US Monitor"처럼 국내 데스크가 작성한 해외 시황
 * 코멘트) market:"kr" 로 고정한다 — 신한 M.R.I 등 다른 브로커의 국내
 * "투자전략" 게시판과 동일한 처리(FOMC·KOSPI 등을 같이 다뤄도 kr 유지).
 * 별도 "해외전용" 게시판이 확인되면 그때 분리.
 *
 * ⚠️ 다른 예외들과 동일 조건: 개인용·하루 1회·저빈도(CLAUDE.md 참고).
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-sangsangin-industry-research.mjs
 *   node scripts/collect-sangsangin-industry-research.mjs --days=90 --dry-run
 */

import { readFileSync } from "node:fs";
import { resolveKrStock, headlineAfterCompany } from "./lib/company-match.mjs";
import { isFxContent, isCommonExcludedContent } from "./lib/exclude-filters.mjs";

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
const PAGE_SIZE = 50;
const MAX_PAGES = Number(arg("pages")) || 10;

const LIST_URL = "https://www.sangsanginib.com/notice/getNoticeList";
const BOARDS = [
  { cmsCd: "CM0338", label: "산업" }, // 산업리포트 — STOCK_NM 을 그대로 씀
  { cmsCd: "CM0078", label: "시장" }, // 주식시장 — STOCK_NM 이 전부 "시장전체"라 브라켓 필요
];
// 리포트가 원래 있던 사이트 게시판(위 BOARDS 주석의 화면 이름) — item 의 board 필드(분류 대조용).
const BOARD_NAME = { CM0338: "산업리포트", CM0078: "주식시장" };
const boardLabel = (cmsCd) => `상상인증권 > 리서치 > ${BOARD_NAME[cmsCd] ?? cmsCd}(${cmsCd})`;
const IMPORT_URL = (
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://macroresearch.vercel.app/api/cron/total-research"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
// Vercel 배포 보호(Vercel Authentication)가 프로덕션에 켜져 있으면 앱에 닿기
// 전에 401 이 난다 — 자동화 우회 비밀값이 있으면 헤더로 같이 보낸다(없으면 생략).
const VERCEL_BYPASS = (ENV.VERCEL_AUTOMATION_BYPASS_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim();
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BRACKET_RE = /^\[(.+)\]\s*(.*)$/;

// 일시적 네트워크 오류에도 전체 수집이 죽지 않도록 재시도(오너 지적,
// 2026-09 — 신한/BNK 수집기에서 GitHub Actions 러너 DNS 일시 장애 실측).
async function fetchPage(cmsCd, startRow, attempt = 1) {
  try {
    const res = await fetch(LIST_URL, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: new URLSearchParams({
        cmsCd,
        rowNum: String(PAGE_SIZE),
        startRow: String(startRow),
        src: "all",
        sdt: "",
        edt: "",
      }).toString(),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const node = Array.isArray(json) ? json[0] : json;
    return { rows: node?.getNoticeList ?? [], total: node?.getCount ?? 0 };
  } catch (err) {
    if (attempt < 3 && /fetch failed|EAI_AGAIN|ECONNRESET|ETIMEDOUT/i.test(String(err.message ?? err))) {
      console.warn(`  ⚠ ${cmsCd} startRow=${startRow} 요청 실패(${attempt}회차), 재시도: ${err.message}`);
      await sleep(2000 * attempt);
      return fetchPage(cmsCd, startRow, attempt + 1);
    }
    throw err;
  }
}

console.log(`▶ 상상인증권 산업리포트/주식시장 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지 × ${BOARDS.length}개 게시판`);
const cutoff = new Date(new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10));
const collected = [];
for (const board of BOARDS) {
  let stop = false;
  let total = 0;
  for (let page = 0; page < MAX_PAGES && !stop; page++) {
    const { rows, total: t } = await fetchPage(board.cmsCd, page * PAGE_SIZE);
    total = t;
    if (rows.length === 0) break;
    for (const r of rows) {
      const date = String(r.REGDT ?? "").replace(/\./g, "-");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      if (new Date(date) < cutoff) {
        stop = true;
        break;
      }
      const rawTitle = String(r.TITLE ?? "").trim();
      const bm = rawTitle.match(BRACKET_RE);
      let stockName;
      let title;
      if (board.cmsCd === "CM0338") {
        // 산업리포트 — STOCK_NM 에 이미 깔끔한 업종명이 있어 그대로 쓴다.
        stockName = String(r.STOCK_NM ?? "").trim() || board.label;
        title = rawTitle;
      } else {
        // 주식시장 — STOCK_NM 이 항상 "시장전체"라 브라켓 라벨을 대신 쓴다.
        // 브라켓이 제목 전체를 감싸고 뒤에 별도 헤드라인이 없는 경우(예:
        // "[Macro Update & Implication(9월2주) - ...]")엔 라벨 자체를
        // title로도 쓴다 — 안 그러면 대괄호가 그대로 남은 원문이 title에
        // 들어간다(실측으로 발견한 버그).
        stockName = bm ? bm[1].trim() : "시장";
        title = bm ? (bm[2].trim() || bm[1].trim()) : rawTitle;
      }
      // 매크로 성격 라벨(경제·채권·원자재)은 산업리포트(STOCK_NM)·주식시장(대괄호 라벨) 어느
      // 게시판에서 오든 다른 증권사와 같은 "브로커 + 라벨" 고정 이름으로 바꿔 앱이 거시경제
      // 이슈분석/환율분석으로 분류하게 한다(오너 지적 2026-09-26 — "경제는 거시경제이다 왜
      // 산업에 계속붙이나"). FX 내용이면 " FX" 를 붙인다(환율분석).
      if (/^(경제|채권|원자재)$/.test(stockName)) {
        stockName = `상상인 ${stockName}${isFxContent(rawTitle) ? " FX" : ""}`;
      }
      // 산업리포트 게시판에 섞인 종목 코멘트("HD현대중공업 증설 공시 코멘트")는 종목분석으로
      // 승격한다 — 제목이 국내 상장사명으로 시작하면(공통 lib, 조사 경계 판정 포함).
      const hit = board.cmsCd === "CM0338" && !bm ? resolveKrStock(rawTitle) : null;
      if (hit) {
        const head = headlineAfterCompany(rawTitle, hit.stockName) || rawTitle;
        if (isCommonExcludedContent(`${hit.stockName} ${head}`, "기업")) continue;
        collected.push({
          id: String(r.NT_NO),
          date,
          title: head,
          stockName: hit.stockName,
          symbol: hit.symbol,
          analyst: String(r.NM ?? "").trim(),
          opinion: "",
          targetPrice: null,
          summary: "",
          pdfUrl:
            r.FILE_YN === "Y"
              ? `https://www.sangsanginib.com/_upload/attFile/${board.cmsCd}/${board.cmsCd}_${r.NT_NO}_1.pdf`
              : null,
          views: typeof r.HIT === "number" ? r.HIT : null,
          category: "기업",
          board: boardLabel(board.cmsCd),
        });
        continue;
      }
      // "Quant Variation Vol.N - Latent Alpha…" 퀀트 리포트 — 수집 제외(오너 지시 2026-09-27).
      if (/Quant\s*Variation/i.test(`${stockName} ${title}`)) continue;
      // "[상상인 US Monitor]" 미국시황 시리즈 — 수집 제외(오너 지시 2026-09-27, "상상인은 미국시황 수집제외").
      if (/US\s*Monitor/i.test(stockName)) continue;
      // "상상인 Macro Daily" — 거의 매일 올라오는 국내 시황 코멘트. 수집 제외(오너 지시 2026-10-01,
      // "시황분석에서 상상인 macro daily는 수집제외").
      if (/Macro\s*Daily/i.test(`${stockName} ${title}`)) continue;
      if (isCommonExcludedContent(`${stockName} ${title}`, "산업")) continue;
      collected.push({
        id: String(r.NT_NO),
        date,
        title,
        stockName,
        symbol: null,
        analyst: String(r.NM ?? "").trim(),
        opinion: "",
        targetPrice: null,
        summary: "",
        pdfUrl:
          r.FILE_YN === "Y"
            ? `https://www.sangsanginib.com/_upload/attFile/${board.cmsCd}/${board.cmsCd}_${r.NT_NO}_1.pdf`
            : null,
        views: typeof r.HIT === "number" ? r.HIT : null,
        category: "산업",
        board: boardLabel(board.cmsCd),
      });
    }
    await sleep(400);
  }
  console.log(`  ${board.cmsCd}(${board.label}) — 사이트 전체 ${total}건`);
}

if (collected.length === 0) {
  console.error("✗ 파싱 결과 0건. API 구조가 바뀌었을 수 있음.");
  // 0건은 실패가 아니다 — 주말·휴일이나 새 글이 없는 날에도 워크플로가 "실패"로
  // 찍혀 진짜 장애를 가리고 로컬 재실행 도구가 헛돌았다(감사 2026-09-28: 일요일
  // 8개 수집기 전부 거짓 실패). 경고만 남기고 정상 종료한다. 파서가 진짜 깨진
  // 경우는 DB 최신 날짜가 며칠째 안 움직이는 것으로 드러난다.
  console.log("::warning::파싱 결과 0건 — 새 글이 없거나 구조가 바뀌었을 수 있음");
  process.exit(0);
}
console.log(`✔ 파싱 완료: ${collected.length}건`);
console.log(
  "  최근 5건:",
  collected.slice(0, 5).map((i) => `${i.date} [${i.stockName}] ${i.title}`),
);

if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
  if (VERCEL_BYPASS) headers["x-vercel-protection-bypass"] = VERCEL_BYPASS;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;
const up = await fetch(IMPORT_URL, {
  method: "POST",
  headers,
  body: JSON.stringify({ items: collected, source: "상상인증권", market: "kr" }),
});
const body = await up.text();
if (!up.ok) {
  console.error(`✗ 앱 전송 실패 HTTP ${up.status}: ${body.slice(0, 300)}`);
  process.exit(1);
}
console.log(`\n✔ 앱 전송 완료: ${body}`);
