/**
 * iM증권(옛 하이투자증권) 리서치 수집기 — 기업분석·산업분석·투자전략·해외기업·
 * Morning Brief(시황) + 경제분석·채권(거시경제 이슈분석). 오너 결정 2026-09-25.
 *
 * ── 조사 근거(실측 2026-09-25) ─────────────────────────────────────
 * www.imfnsec.com 화면은 레거시 frameset 이지만, 게시판 목록은 화면 JS 가 부르는
 * 내부 JSON 엔드포인트에서 온다(로그인 불필요, UTF-8):
 *
 *   POST /_json/source.jsp   (application/x-www-form-urlencoded)
 *     tr_cd=db/board/TWBBACL/board_list&bid={게시판}&cur_page=N&num_page=300
 *     &keyOption=ALL&iKey=%2525%2525&sdate=YYYYMMDD&edate=YYYYMMDD&secureKey={KEY}
 *   응답: [[행...],[{total_count}],[]]
 *
 * 세션 키 절차(없으면 빈 응답 — 오류로 감지해 exit 1):
 *   ① 아무 페이지 GET → JSESSIONID 쿠키
 *   ② KEY = base64("sJS" + Date.now()) 를 POST /inc/common/PrivateSecuerKey.jsp
 *      (`_secureKey=KEY`)로 등록
 *   ③ 같은 쿠키로 secureKey=KEY 를 실어 호출
 *
 * 행 필드: title, reg_dt("2026/09/21"), username, aid, bid(하위 게시판 코드 —
 * 예 R_E081), bflag, view_cnt. body 는 비어 있다. **aid 는 하위 게시판마다 따로
 * 매겨진다**(실측 — R_E038 aid 79, R_E031 aid 469, R_E037 aid 73) → 문서 id 는
 * `{하위 bid}-{aid}` 로 만든다(aid 만 쓰면 게시판끼리 덮어쓴다).
 *
 * 첨부(PDF): 같은 엔드포인트 `tr_cd=db/research/twbbacl_attach&bid={하위 bid}
 * &aid={aid}` → file_dir("R_E08/2026/09")·file_name("[21075819]_373220.pdf").
 * PDF 는 `/upload/{file_dir}/{file_name}` 로 쿠키 없이 받아진다(실측 200
 * application/pdf). **pdfUrl 은 PDF 직링크가 1순위**(오너 결정 — 모든 게시판에
 * 첨부 조회), PDF 가 없는 건만 기업·산업분석 상세 화면
 * (`/research/bussiness_indust/re020301.jsp?bid=&aid=`, GET 으로 열림 실측)으로
 * 폴백하고, 그 외 게시판은 링크가 없으면 버린다(화면에서 링크 없는 항목은 버려짐).
 * 기업분석은 file_name 끝 6자리가 종목코드다(다른 게시판은 bflag).
 *
 * robots.txt 는 없다(요청 시 다른 페이지로 리다이렉트). 다른 예외들과 동일 조건
 * (개인용·저빈도·요청 간격)으로 진행.
 *
 * ── 게시판 → 앱 목적지(오너 결정, 삼성증권과 같은 기준) ──────────────
 *   | bid    | 사이트 분류                 | 앱 목적지                              |
 *   |--------|-----------------------------|----------------------------------------|
 *   | R_E08  | 기업분석(행 R_E081)          | 국내 종목분석 "[종목명/의견] 헤드라인"  |
 *   | R_E14  | 해외기업(R_E141)             | 미국 종목분석 "[회사명(TICKER-US)] …"  |
 *   | R_E09  | 산업분석(R_E091·R_E092)      | 국내 산업분석(라벨 = 대괄호, 의견 제거)  |
 *   | R_E03  | 투자전략 R_E031 마켓 준클리  | 미수집(오너 지시 — "마켓준클릭은 수집에서 제외다") |
 *   |        |          R_E037 해외주식     | 미국 투자전략 "iM증권 투자전략"         |
 *   |        |          R_E038 디지털자산   | 미수집(다른 증권사도 안 받음)           |
 *   | R_E04  | 경제분석                     | 거시경제 이슈분석/환율분석(kr_research)  |
 *   | R_E05  | 채권                         | 거시경제 이슈분석/환율분석(kr_research)  |
 *
 * R_E010(Morning Brief)은 수집하지 않는다(오너 결정 2026-09-25 — "im증권
 * Morning Brief는 수집제외다").
 *
 * 고정 라벨("iM증권 투자전략")은 게시판 단위 확정 분류용
 * stockName — `src/lib/db/shinhan-research.ts` 의 STRATEGY_/MARKET_CONDITION_
 * STOCKNAMES 에 같은 문자열로 등록돼야 확정 분류된다(이 수집기는 등록하지 않음).
 *
 * 공통 제외(`scripts/lib/exclude-filters.mjs`): ETF/ETP·ESG·주간물·일정표·
 * 추천종목·원자재 외 대체투자. 원자재 글은 기업이 아니면 이슈분석으로 보낸다.
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-im-research.mjs
 *   node scripts/collect-im-research.mjs --days=14 --dry-run
 */

import { readFileSync } from "node:fs";
import { enrichResearch } from "./lib/research-extract.mjs";
import { isEtfOrEtpContent, isEsgContent, isCommonExcludedContent, isCommodityContent, isFxContent } from "./lib/exclude-filters.mjs";
import { industryLabelAndHeadline } from "./lib/label-extract.mjs";
import { appUrl } from "./lib/app-url.mjs";
import { appSendFailed, exitNoItems } from "./lib/collector-status.mjs";

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
const DAYS = Number(ARGS.find((a) => a.startsWith("--days="))?.split("=")[1]) || 3;

const IMPORT_URL = (
  ENV.SHINHAN_RESEARCH_IMPORT_URL || `${appUrl(ENV)}/api/cron/total-research`
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim();
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GAP_MS = 400;

const BASE = "https://www.imfnsec.com";
const SOURCE = "iM증권";
const STRATEGY_LABEL = "iM증권 투자전략";

// kind: krCompany / usCompany / industry / strategy / daily / macro
const BOARDS = [
  { bid: "R_E08", label: "기업분석", kind: "krCompany" },
  { bid: "R_E14", label: "해외기업", kind: "usCompany" },
  { bid: "R_E09", label: "산업분석", kind: "industry" },
  { bid: "R_E03", label: "투자전략", kind: "strategy" },
  { bid: "R_E04", label: "경제분석", kind: "macro" },
  { bid: "R_E05", label: "채권", kind: "macro" },
];
// R_E031(마켓 준클리)은 수집 제외(오너 지시 2026-09-25 — "마켓준클릭은
// 수집에서 제외다"), R_E038(디지털자산)도 제외.
const STRATEGY_SUB = { R_E037: "us" };
// 첨부가 없을 때 쓸 상세 화면(GET 으로 열리는 것 확인한 게시판만).
const VIEWER_BOARDS = new Set(["R_E08", "R_E09"]);

// "[LG에너지솔루션/Buy] 헤드라인" — 의견은 마지막 슬래시 뒤.
const KR_TITLE_RE = /^\[(.+)\/([^/\]]+)\]\s*(.+)$/;
// "[Valero Energy(VLO-US)] 헤드라인"
const US_TITLE_RE = /^\[(.+?)\s*\(([A-Za-z0-9.]{1,10})-([A-Z]{2})\)\]\s*(.+)$/;
// 산업 라벨 끝의 업종 투자의견: "/Overweight", "(Overweight)", " OW", 오탈자 "Overwegith".
const SECTOR_OPINION_RE =
  /\s*(?:[/(]\s*|\s)(?:overweight|overwegith|underweight|neutral|positive|negative|ow|uw|비중확대|중립|비중축소)\s*\)?\s*$/i;
const PREFIX_RE = /^\[(?:해외주식|Morning Brief)\]\s*/i;

// 상장 종목코드 → 이름(첨부 파일명 끝 6자리 검증용).
const CORP_NAMES = new Map(
  JSON.parse(readFileSync(new URL("../src/lib/markets/kr/data/corpcodes.json", import.meta.url), "utf8")).map((c) => [
    c.s,
    c.n,
  ]),
);

// ── 세션 ──────────────────────────────────────────────────────────
let cookie = "";
let secureKey = "";
function keepCookies(res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const kv = c.split(";")[0];
    const name = kv.split("=")[0];
    cookie = cookie
      .split("; ")
      .filter((x) => x && !x.startsWith(name + "="))
      .concat(kv)
      .join("; ");
  }
}
async function openSession() {
  const home = await fetch(BASE + "/", { headers: { "User-Agent": UA } });
  keepCookies(home);
  await home.text();
  if (!cookie.includes("JSESSIONID")) throw new Error("JSESSIONID 쿠키를 받지 못함");
  await sleep(GAP_MS);
  secureKey = Buffer.from("sJS" + Date.now()).toString("base64");
  const reg = await fetch(BASE + "/inc/common/PrivateSecuerKey.jsp", {
    method: "POST",
    headers: { "User-Agent": UA, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: "_secureKey=" + encodeURIComponent(secureKey),
  });
  keepCookies(reg);
  await reg.text();
  if (!reg.ok) throw new Error(`secureKey 등록 실패 HTTP ${reg.status}`);
}
async function query(params) {
  await sleep(GAP_MS);
  const body = `${params}&secureKey=${encodeURIComponent(secureKey)}`;
  const res = await fetch(BASE + "/_json/source.jsp", {
    method: "POST",
    headers: { "User-Agent": UA, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = (await res.text()).trim();
  // 세션 키가 안 맞으면 200 + 빈 본문 — 조용히 0건으로 넘어가지 않게 오류로.
  if (!text) throw new Error("빈 응답(세션 키/쿠키 거부)");
  return JSON.parse(text);
}

function ymd(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

async function fetchBoard(bid, sdate, edate) {
  const rows = [];
  for (let page = 1; page <= 20; page++) {
    const j = await query(
      `tr_cd=db/board/TWBBACL/board_list&bid=${bid}&cur_page=${page}&num_page=300&keyOption=ALL&iKey=%2525%2525&sdate=${sdate}&edate=${edate}`,
    );
    const list = Array.isArray(j?.[0]) ? j[0] : null;
    if (!list) throw new Error(`${bid}: 응답 형식이 다름`);
    rows.push(...list);
    const total = Number(j?.[1]?.[0]?.total_count ?? 0);
    if (list.length === 0 || rows.length >= total) break;
  }
  return rows;
}

async function fetchAttach(subBid, aid) {
  const j = await query(`tr_cd=db/research/twbbacl_attach&bid=${subBid}&aid=${aid}`);
  const files = (Array.isArray(j?.[0]) ? j[0] : []).filter((f) => /\.pdf$/i.test(f.file_name ?? ""));
  return files[0] ?? null;
}

// ── 분류 ──────────────────────────────────────────────────────────
function baseItem(row, board) {
  return {
    id: `${row.bid}-${row.aid}`,
    date: String(row.reg_dt ?? "").replaceAll("/", "-"),
    analyst: String(row.username ?? "").trim(),
    opinion: "",
    targetPrice: null,
    summary: "",
    pdfUrl: null,
    views: Number(row.view_cnt) || null,
    board: board.bid,
    subBid: row.bid,
    aid: row.aid,
    bflag: row.bflag,
  };
}

/** 행 → 항목(null 이면 건너뜀). 이슈분석은 topic 을 단다. */
function classify(row, board) {
  const title = String(row.title ?? "").replace(/\s+/g, " ").trim();
  if (!title) return null;
  if (isEtfOrEtpContent(title) || isEsgContent(title) || isCommonExcludedContent(title)) return null;
  const base = baseItem(row, board);
  // 공용 FX 판정(오너 지적 2026-09-25) — 경제·채권 게시판이 FX 분기 없이 전부
  // 이슈분석으로만 갔다(실측: "거침없는 원화 강세..."·"가속 페달을 밟은 달러-엔").
  // 리서치 분류 체계 전면 개편(2026-09-26)으로 macro_issues 컬렉션 폐지 —
  // 고정 stockName(shinhan-research.ts FORCED_ISSUE_STOCKNAMES/
  // FORCED_FX_STOCKNAMES 등록)으로 kr_research에 합류시킨다.
  if (board.kind === "macro") {
    const isFx = isFxContent(title);
    const label = board.bid === "R_E05" ? "iM증권 채권" : "iM증권 경제분석";
    return { ...base, title, stockName: isFx ? `${label} FX` : label, symbol: null, category: "산업", market: "kr" };
  }

  if (board.kind === "krCompany") {
    const m = title.match(KR_TITLE_RE);
    if (m) {
      const [, stockName, opinion, headline] = m;
      return {
        ...base,
        title: headline.trim(),
        stockName: stockName.trim(),
        symbol: null, // 첨부 파일명으로 채움
        opinion: opinion.trim(),
        opinionFrom: "title",
        category: "기업",
        market: "kr",
      };
    }
    // 형식 밖 제목은 산업으로(아래 공통 처리).
  }
  if (board.kind === "usCompany") {
    const m = title.match(US_TITLE_RE);
    if (!m) return null;
    const [, stockName, ticker, exch, headline] = m;
    if (exch !== "US") return null; // 다른 시장은 건너뜀
    return {
      ...base,
      title: headline.trim(),
      stockName: stockName.trim(),
      symbol: ticker.toUpperCase(),
      category: "기업",
      market: "us",
    };
  }
  // 이하 비종목 글 — 원자재는 이슈분석으로.
  if (isCommodityContent(title)) {
    const isFx = isFxContent(title);
    return {
      ...base,
      title,
      stockName: isFx ? "iM증권 원자재 FX" : "iM증권 원자재",
      symbol: null,
      category: "산업",
      market: "kr",
    };
  }
  if (board.kind === "strategy") {
    const market = STRATEGY_SUB[row.bid];
    if (!market) return null; // 디지털자산 등
    return { ...base, title: title.replace(PREFIX_RE, ""), stockName: STRATEGY_LABEL, symbol: null, category: "산업", market };
  }
  // industry(및 형식 밖 기업분석 제목)
  const { label: rawLabel, headline } = industryLabelAndHeadline(title);
  const label = rawLabel.replace(SECTOR_OPINION_RE, "").trim() || "산업";
  return { ...base, title: headline.replace(/^[:：;]\s*/, ""), stockName: label, symbol: null, category: "산업", market: "kr" };
}

// ── 실행 ──────────────────────────────────────────────────────────
console.log(`▶ iM증권 리서치 수집(${BOARDS.map((b) => b.label).join("·")}): 최근 ${DAYS}일`);
const now = new Date();
const sdate = ymd(new Date(now.getTime() - DAYS * 86_400_000));
const edate = ymd(now);

await openSession();

const collected = [];
let rawTotal = 0;
for (const board of BOARDS) {
  const rows = await fetchBoard(board.bid, sdate, edate);
  rawTotal += rows.length;
  const items = rows.map((r) => classify(r, board)).filter(Boolean);
  console.log(`  ${board.label}(${board.bid}): 원본 ${rows.length}건 → 수집 ${items.length}건`);
  collected.push(...items);
}
if (rawTotal === 0) {
  // 0건은 실패가 아니다 — 오라클 10~18시 회차는 최근 1일만 보므로 주말·휴일엔 정상적으로 0건이다(2026-10-04 일요일 오경보).
  // 세션 키·쿠키 거부는 위 요청 함수가 빈 응답을 오류로 던져 따로 잡는다.
  exitNoItems({ market: "kr", label: "im" });
}

// 첨부 조회 → PDF 직링크(1순위), 기업분석은 파일명 끝 6자리로 종목코드.
console.log(`▶ 첨부(PDF) 조회 ${collected.length}건...`);
let noPdf = 0;
let symbolMismatch = 0;
const withLink = [];
for (const it of collected) {
  const f = await fetchAttach(it.subBid, it.aid);
  if (f?.file_dir && f?.file_name) {
    it.pdfUrl = `${BASE}/upload/${f.file_dir}/${encodeURIComponent(f.file_name)}`;
    if (it.category === "기업" && it.market === "kr") {
      const code = f.file_name.match(/_(\d{6})\.pdf$/i)?.[1];
      if (code && code !== String(it.bflag) && CORP_NAMES.has(code)) {
        it.symbol = code;
        const listed = CORP_NAMES.get(code).replace(/\s/g, "");
        if (listed !== it.stockName.replace(/\s/g, "")) {
          symbolMismatch++;
          console.log(`  ⚠ 종목명 불일치(코드 사용): ${it.stockName} ↔ ${CORP_NAMES.get(code)}(${code})`);
        }
      }
    }
  } else {
    noPdf++;
    if (VIEWER_BOARDS.has(it.board)) {
      it.pdfUrl = `${BASE}/research/bussiness_indust/re020301.jsp?bid=${it.subBid}&aid=${it.aid}`;
    } else {
      console.log(`  ⚠ PDF 없음 — 제외: [${it.subBid}] ${it.title}`);
      continue;
    }
  }
  withLink.push(it);
}

const research = withLink;
console.log(`✔ 파싱 완료: ${research.length}건 (PDF 없음 ${noPdf}건)`);

// 투자의견·목표주가 — 공용 추출기(항목별 market 으로 통화 규칙).
const stockItems = research.filter((it) => it.category === "기업");
console.log(`▶ 투자의견/목표주가 조회 중 (PDF 포함, 로그인 불필요) — ${stockItems.length}건...`);
await enrichResearch(stockItems, { market: "kr", sleepMs: GAP_MS, usePdf: true });

for (const i of withLink) {
  console.log(
    `  [${i.subBid}→${i.topic ?? `${i.market}/${i.category}`}] ${i.date} ${i.symbol ?? i.stockName ?? ""}${i.opinion ? `(${i.opinion})` : ""}${i.targetPrice != null ? ` TP ${i.targetPrice}` : ""} — ${i.title} [${i.analyst}]`,
  );
}
if (stockItems.length > 0) {
  const kr = stockItems.filter((i) => i.market === "kr");
  const pct = (n, d) => (d ? `${n}/${d} (${Math.round((n / d) * 100)}%)` : "0/0");
  console.log(
    `  기업 ${stockItems.length}건 — 종목코드 ${pct(stockItems.filter((i) => i.symbol).length, stockItems.length)}` +
      ` · 의견 ${pct(stockItems.filter((i) => i.opinion).length, stockItems.length)}` +
      ` · 목표가 ${pct(stockItems.filter((i) => i.targetPrice != null).length, stockItems.length)}` +
      ` · 국내 ${kr.length}건(종목명 불일치 ${symbolMismatch})`,
  );
}

if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;

// 라우트가 POST 1회당 source·market 하나만 받으므로 market 별로 나눠 전송.
const groups = new Map();
for (const it of research) {
  if (!groups.has(it.market)) groups.set(it.market, []);
  groups.get(it.market).push({
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
    // 원 게시판(사이트 메뉴) — 대조·검수용. it.board 는 게시판 코드(bid), 세부 코드는 subBid.
    board: `iM증권 > ${BOARDS.find((b) => b.bid === it.board)?.label ?? it.board}(${it.board}${it.subBid && it.subBid !== it.board ? `/${it.subBid}` : ""})`,
  });
}
for (const [market, items] of groups) {
  const up = await fetch(IMPORT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ items, source: SOURCE, market }),
  });
  const upBody = await up.text();
  if (appSendFailed(up, upBody)) {
    console.error(`✗ [${SOURCE}/${market}] 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`✔ [${SOURCE}/${market}] 앱 전송 완료 (${items.length}건): ${upBody}`);
}
