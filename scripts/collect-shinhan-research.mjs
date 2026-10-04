/**
 * 신한투자증권 "기업분석" 리포트 — 로컬 수집기.
 *
 * bbs2.shinhansec.com 의 게시판 JSON API(로그인 불필요, 실제 브라우저 XHR을
 * 그대로 재현 — 페이지 소스에는 없고 클라이언트 JS가 호출)에서 최신 리포트를
 * 가져와 앱(Vercel)의 DB 적재 라우트로 전송한다.
 *
 * ⚠️ bbs2.shinhansec.com/robots.txt 는 `Disallow: /` 다. 다른 예외들과 동일하게
 *    프로젝트 오너가 "개인용·로컬 실행·저빈도" 조건으로 예외 승인(CLAUDE.md 참조).
 *    앱 배포본(Vercel)에는 이 수집 코드가 없다 — DB 적재 라우트는 결과를 받기만 함.
 *
 * 목표주가 PDF 폴백(2026-09 추가): "Review" 후속 리포트는 본문(f7)에
 * "목표주가는 유지"라고만 쓰고 숫자를 다시 안 적는 경우가 많다(실측 —
 * LS 사례). 그 경우 PDF 표지 헤더("목표주가 600,000 원 (유지)")에는 항상
 * 숫자가 있어(다른 브로커 PDF와 동일 패턴) 본문에서 못 찾았을 때만 PDF를
 * 내려받아 재시도한다 — 매번 받지 않고 폴백일 때만이라 비용 최소화.
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-shinhan-research.mjs             # 최근 14일, 최대 5페이지
 *   node scripts/collect-shinhan-research.mjs --days=30 --pages=10
 *   node scripts/collect-shinhan-research.mjs --dry-run   # 전송 안 하고 파싱 결과만
 *
 * ── 설정 (.env.local, 선택) ─────────────────────────────────────────
 *   SHINHAN_RESEARCH_IMPORT_URL="https://macro-insights.duckdns.org/api/cron/total-research"
 *   CRON_SECRET="앱에 설정한 값이 있으면"
 */

import { readFileSync } from "node:fs";
import { enrichResearch } from "./lib/research-extract.mjs";
import { isCommonExcludedContent, isUnlistedCompanyTag } from "./lib/exclude-filters.mjs";
import { refineSectorLabels } from "./lib/sector-label.mjs";
import { appUrl } from "./lib/app-url.mjs";

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
const DAYS = Number(ARGS.find((a) => a.startsWith("--days="))?.split("=")[1]) || 14;
// 페이지당 실제로 넘어가는 항목 수가 적어(실측: 60일치 커버하는 데 23페이지
// 필요) 기본값 5는 14일 기본 조회 기간도 못 채우고 끊길 수 있었다(실측
// 확인 — HD현대일렉트릭 7/29자 리포트가 누락됐었음). 여유 있게 10으로 상향.
const MAX_PAGES = Number(ARGS.find((a) => a.startsWith("--pages="))?.split("=")[1]) || 10;

const IMPORT_URL = (
  ENV.SHINHAN_RESEARCH_IMPORT_URL || `${appUrl(ENV)}/api/cron/total-research`
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
// Vercel 배포 보호(Vercel Authentication)가 프로덕션에 켜져 있으면 앱에 닿기
// 전에 401 이 난다 — 자동화 우회 비밀값이 있으면 헤더로 같이 보낸다(없으면 생략).
const VERCEL_BYPASS = (ENV.VERCEL_AUTOMATION_BYPASS_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim(); // 로컬 수동 실행 시 CRON_SECRET 없어도 인증 가능(라우트가 x-app-token도 허용)

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isoDate = (s) => {
  const m = String(s).trim().match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

function decodeEntities(s) {
  return s
    .replace(/&lsquo;|&rsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&ndash;|&mdash;/g, "-")
    .replace(/&middot;/g, "·")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// 반복되는 "신한생각: ..." 헤더가 본문에 여러 번 겹쳐 나오는 원본 특성상,
// 앞부분만 발췌(요약 카드에 이미 노출되는 분량 정도)하고 개행은 공백으로 접는다.
const EXCERPT_LEN = 300;
function excerpt(text) {
  const flat = decodeEntities(String(text ?? ""))
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return flat.length > EXCERPT_LEN ? `${flat.slice(0, EXCERPT_LEN)}…` : flat;
}

// 본문(f7) 뒷부분에 "매수 의견과 목표주가 65만원 유지" 처럼 만원 단위로 섞여
// 나온다 — excerpt()로 자르기 전 원문 전체(bodyText)를 공용 추출기에 넘긴다.

// 일시적 네트워크 오류("fetch failed"/소켓 리셋 등, 2026-09 실측 —
// bbs2.shinhansec.com이 이따금 연결을 끊어 스케줄 실행 전체가 그 날 통째로
// 실패했다)에도 전체 수집이 죽지 않도록 페이지당 재시도를 둔다. 하루 2회
// 스케줄(오너 지시, 2026-09 — "작성시간과 로드시간의 시차")로도 다음 실행
// 때 자연 복구되지만, 한 번의 일시적 오류로 그 회차 전체를 날리지 않는 게
// 더 안전하다.
async function fetchPage(board, curPage, startId, attempt = 1) {
  const url = new URL(`https://bbs2.shinhansec.com/bbs/list/${board}`);
  url.searchParams.set("v", String(Date.now()));
  url.searchParams.set("curPage", String(curPage));
  url.searchParams.set("startPage", String(curPage));
  if (startId) url.searchParams.set("startId", startId);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, "X-Requested-With": "XMLHttpRequest" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.includes("errorWrapper")) throw new Error("게시판 API 404(구조 변경?)");
    return JSON.parse(text);
  } catch (err) {
    if (attempt < 3 && /fetch failed|SocketError|ECONNRESET|ETIMEDOUT/i.test(String(err.message ?? err))) {
      console.warn(`  ⚠ 페이지 ${curPage} 요청 실패(${attempt}회차), 재시도: ${err.message}`);
      await sleep(2000 * attempt);
      return fetchPage(board, curPage, startId, attempt + 1);
    }
    throw err;
  }
}

console.log(`▶ 신한투자증권 기업분석 리포트 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지`);

// 항목 날짜가 'YYYY-MM-DD'(=UTC 자정)라 컷오프도 자정으로 맞춘다.
// Date.now() 기준 그대로 두면 '정확히 DAYS일 전' 리포트가 시:분 차이로
// 매번 잘려나간다(실측 2026-09: 미래에셋 최신 리포트가 3시간 차이로 탈락).
const cutoff = new Date(new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10));
const items = [];
let startId = undefined;
let stop = false;

for (let page = 1; page <= MAX_PAGES && !stop; page++) {
  const data = await fetchPage("gicompanyanalyst", page, startId);
  const list = data.list ?? [];
  if (list.length === 0) break;
  for (const it of list) {
    const date = isoDate(it.f0);
    if (!date) continue;
    if (new Date(date) < cutoff) {
      stop = true;
      break;
    }
    const pdfUrl = it.f3 || null;
    if (isCommonExcludedContent(`${it.f2} ${it.f1}`, "기업")) continue;
    items.push({
      id: String(it.fn),
      date,
      title: it.f1,
      stockName: it.f2,
      analyst: it.f4,
      opinion: it.f6, // 목록 칸 — 공용 추출기가 본문 언급 확인 후 사용
      targetPrice: null,
      summary: excerpt(it.f7),
      bodyText: String(it.f7 ?? ""),
      pdfUrl,
      views: Number(it.f5) || null,
      board: "신한투자증권 > 기업분석(gicompanyanalyst)",
    });
  }
  const pages = data.pageInfo?.pages ?? [];
  startId = pages.length > 1 ? pages[1] : undefined;
  if (!startId) break;
  await sleep(400); // 예의상 간격
}

// 산업분석(boardName=giindustry) — 구 collect-shinhan-industry-research.mjs.
console.log(`▶ 신한투자증권 산업분석 리포트 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지`);
{
  let iStartId;
  let iStop = false;
  for (let page = 1; page <= MAX_PAGES && !iStop; page++) {
    const data = await fetchPage("giindustry", page, iStartId);
    const list = data.list ?? [];
    if (list.length === 0) break;
    for (const it of list) {
      const date = isoDate(it.f0);
      if (!date) continue;
      if (new Date(date) < cutoff) {
        iStop = true;
        break;
      }
      const stockName = it.f2 && it.f2 !== "-" ? it.f2.trim() : "산업";
      let title = decodeEntities(String(it.f1 ?? "")).trim();
      const pm = title.match(/^([^;]+);\s*(.+)$/);
      if (pm && pm[1].trim() === stockName) title = pm[2].trim();
      if (isCommonExcludedContent(`${stockName} ${title}`, "산업")) continue;
      items.push({
        id: String(it.fn),
        date,
        title,
        stockName,
        symbol: null,
        analyst: it.f4 ?? "",
        opinion: "",
        targetPrice: null,
        summary: excerpt(it.f7),
        pdfUrl: it.f3 || null,
        views: Number(it.f5) || null,
        category: "산업",
        board: "신한투자증권 > 산업분석(giindustry)",
      });
    }
    const pages = data.pageInfo?.pages ?? [];
    iStartId = pages.length > 1 ? pages[1] : undefined;
    if (!iStartId) break;
    await sleep(400);
  }
}

// 해외 산업/기업분석(boardName=foreignstock, 미국만) — 구
// collect-shinhan-overseas-research.mjs.
console.log(`▶ 신한투자증권 해외 기업분석 수집: 최근 ${DAYS}일, 최대 30페이지`);
const TITLE_US_RE = /\(([A-Z][A-Z.]{0,5})\.US\)\s*$/;
{
  let oStartId;
  let oStop = false;
  for (let page = 1; page <= 30 && !oStop; page++) {
    const data = await fetchPage("foreignstock", page, oStartId);
    const list = data.list ?? [];
    if (list.length === 0) break;
    for (const it of list) {
      const date = isoDate(it.f0);
      if (!date) continue;
      if (new Date(date) < cutoff) {
        oStop = true;
        break;
      }
      const stockField = String(it.f2 ?? "").trim();
      const tm = stockField.match(TITLE_US_RE);
      // "글로벌 이슈; 주제" 시리즈는 테마·산업 리포트라 f2 에 대표 종목이 붙어 있어도 종목분석이 아니다(오너 지적 2026-09-27 — 네오클라우드·
      // 모더나 암 백신·헬스케어 실적 리뷰 등이 종목분석으로 새던 것). 대표 종목과 무관하게 산업으로 받는다.
      if (/^글로벌\s*이슈\s*;/.test(String(it.f1 ?? "").trim())) {
        if (!isCommonExcludedContent(it.f1, "산업")) {
          items.push({
            id: String(it.fn),
            date,
            title: it.f1,
            stockName: "글로벌 이슈",
            symbol: null,
            analyst: it.f4 ?? "",
            opinion: "",
            targetPrice: null,
            summary: excerpt(it.f7),
            pdfUrl: it.f3 || null,
            views: Number(it.f5) || null,
            category: "산업",
            board: "신한투자증권 > 해외 산업 및 기업분석(foreignstock)",
            market: "us",
          });
        }
        continue;
      }
      if (!tm) {
        if ((stockField === "-" || stockField === "") && !isCommonExcludedContent(it.f1, "산업")) {
          items.push({
            id: String(it.fn),
            date,
            title: it.f1,
            stockName: "글로벌전략",
            symbol: null,
            analyst: it.f4 ?? "",
            opinion: "",
            targetPrice: null,
            summary: excerpt(it.f7),
            pdfUrl: it.f3 || null,
            views: Number(it.f5) || null,
            category: "산업",
            board: "신한투자증권 > 해외 산업 및 기업분석(foreignstock)",
            market: "us",
          });
        }
        continue;
      }
      // "9월 해외주식 탑픽 10선"은 종목 리포트가 아니라 투자전략(오너 지적 2026-09-27) — 첫 종목명이 붙어 종목분석으로 새던 것.
      if (/해외주식\s*탑픽/.test(String(it.f1 ?? ""))) {
        items.push({
          id: String(it.fn),
          date,
          title: it.f1,
          stockName: "신한 해외주식 탑픽",
          symbol: null,
          analyst: it.f4 ?? "",
          opinion: "",
          targetPrice: null,
          summary: excerpt(it.f7),
          pdfUrl: it.f3 || null,
          views: Number(it.f5) || null,
          category: "산업",
          board: "신한투자증권 > 해외 산업 및 기업분석(foreignstock)",
          market: "us",
        });
        continue;
      }
      if (isCommonExcludedContent(`${stockField} ${it.f1}`, "기업")) continue;
      items.push({
        id: String(it.fn),
        date,
        title: it.f1,
        stockName: stockField.replace(TITLE_US_RE, "").trim(),
        symbol: tm[1],
        analyst: it.f4 ?? "",
        opinion: "",
        targetPrice: null,
        summary: excerpt(it.f7),
        pdfUrl: it.f3 || null,
        views: Number(it.f5) || null,
        category: "기업",
        board: "신한투자증권 > 해외 산업 및 기업분석(foreignstock)",
        market: "us",
      });
    }
    const pages = data.pageInfo?.pages ?? [];
    oStartId = pages.length > 1 ? pages[1] : undefined;
    if (!oStartId) break;
    await sleep(400);
  }
}

// 투자전략(gicomment)·경제분석(gieconomy) — 구 collect-shinhan-strategy-research.mjs.
console.log(`▶ 신한투자증권 투자전략/경제분석 리포트 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지`);
const STRATEGY_SEMI_RE = /^([^;]+);\s*(.+)$/;
const STRATEGY_DASH_RE = /^(\S[^-]{0,20}\S)\s*-\s*(.+)$/;
function splitStrategyLabel(title) {
  const sm = title.match(STRATEGY_SEMI_RE);
  if (sm) return { label: sm[1].trim(), rest: sm[2].trim() };
  const dm = title.match(STRATEGY_DASH_RE);
  if (dm) return { label: dm[1].trim(), rest: dm[2].trim() };
  return { label: "투자전략", rest: title };
}
const STRATEGY_SERIES_LABEL_RE =
  /^(?:(?:\d{1,2}월\s*)?Econ\s*Signal|국내\s*주식\s*마감\s*시황|마켓레이더|국내\s*주식\s*전략|글로벌\s*주식\s*전략|자산가격\s*[메매]커니즘\s*변화|신한\s*(?:FX|Econ)\s*Check-?up)$/i;
const STRATEGY_NON_US_RE =
  /중국|차이나|China|일본|엔화|엔캐리|Japan|유럽|Europe|베트남|Vietnam|인도(?!네시아)|India\b|신흥국|이머징|Emerging|브라질|Brazil|대만|Taiwan/i;
const STRATEGY_US_HINT_RE = /미국|\bUS\b|나스닥|Nasdaq|S&P|다우|연준|\bFed\b|FOMC|월가|Wall Street|글로벌|Global/i;
function classifyStrategyMarket(label, title) {
  if (/^국내/.test(label) || /^국내/.test(title)) return "kr";
  if (STRATEGY_NON_US_RE.test(`${label} ${title}`)) return null;
  if (STRATEGY_US_HINT_RE.test(`${label} ${title}`)) return "us";
  return "kr";
}
for (const board of ["gicomment", "gieconomy"]) {
  let sStartId;
  let sStop = false;
  for (let page = 1; page <= MAX_PAGES && !sStop; page++) {
    const data = await fetchPage(board, page, sStartId);
    const list = data.list ?? [];
    if (list.length === 0) break;
    for (const it of list) {
      const date = isoDate(it.f0);
      if (!date) continue;
      if (new Date(date) < cutoff) {
        sStop = true;
        break;
      }
      const rawTitle = decodeEntities(String(it.f1 ?? "")).trim();
      // 정기 시리즈 라벨만 살리고, 한 번 나오는 제목 앞머리("미국 FOMC"·"10월 Econ Signal")는 시리즈가 아니므로 라벨을 "투자전략"으로
      // 두고 제목을 통째로 유지한다(오너 지적 2026-09-27 — 1건짜리 폴더가 리포트마다 생김). 분류는 제목 키워드가 이어받는다.
      const split = splitStrategyLabel(rawTitle);
      const isSeries = STRATEGY_SERIES_LABEL_RE.test(split.label);
      const boardLabel = board === "gieconomy" ? "경제분석" : "투자전략";
      const label = isSeries ? split.label.replace(/^\d{1,2}월\s*(?=Econ)/i, "") : boardLabel;
      const rest = isSeries ? split.rest : rawTitle;
      const market = classifyStrategyMarket(split.label, rawTitle);
      if (!market) continue;
      if (isCommonExcludedContent(`${label} ${rawTitle}`, "산업")) continue;
      items.push({
        id: String(it.fn),
        date,
        title: rest,
        stockName: `${boardLabel} · ${label}`,
        symbol: null,
        analyst: it.f4 ?? "",
        opinion: "",
        targetPrice: null,
        summary: excerpt(it.f7),
        pdfUrl: it.f3 || null,
        views: Number(it.f5) || null,
        category: "산업",
        board: `신한투자증권 > ${board === "gicomment" ? "투자전략(gicomment)" : "경제분석(gieconomy)"}`,
        market,
      });
    }
    const pages = data.pageInfo?.pages ?? [];
    sStartId = pages.length > 1 ? pages[1] : undefined;
    if (!sStartId) break;
    await sleep(400);
  }
}

// 국내외 채권전략(gibond) — 오너 지시 2026-09-27: "채권전략"이라고 되어 있으면(또는 Fixed Income) 이슈분석 채권, 없으면 경제.
// 크레딧·신용·회사채 글은 공통 제외(isCommonExcludedContent)로 빠지고, 크레딧 전용 게시판(foreignbond)은 수집하지 않는다.
console.log(`▶ 신한투자증권 국내외 채권전략 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지`);
const BOND_STRATEGY_TITLE_RE = /채권\s?전략|Fixed\s?Income/i;
{
  let bStartId;
  let bStop = false;
  for (let page = 1; page <= MAX_PAGES && !bStop; page++) {
    const data = await fetchPage("gibond", page, bStartId);
    const list = data.list ?? [];
    if (list.length === 0) break;
    for (const it of list) {
      const date = isoDate(it.f0);
      if (!date) continue;
      if (new Date(date) < cutoff) {
        bStop = true;
        break;
      }
      const title = decodeEntities(String(it.f1 ?? "")).trim();
      if (isCommonExcludedContent(title, "산업")) continue;
      items.push({
        id: String(it.fn),
        date,
        title,
        stockName: BOND_STRATEGY_TITLE_RE.test(title) ? "신한 채권전략" : "신한 경제",
        symbol: null,
        analyst: it.f4 ?? "",
        opinion: "",
        targetPrice: null,
        summary: excerpt(it.f7),
        pdfUrl: it.f3 || null,
        views: Number(it.f5) || null,
        category: "산업",
        board: "신한투자증권 > 국내외 채권전략(gibond)",
        market: "kr",
      });
    }
    const pages = data.pageInfo?.pages ?? [];
    bStartId = pages.length > 1 ? pages[1] : undefined;
    if (!bStartId) break;
    await sleep(400);
  }
}

// 기업분석 > 비상장분석(boardName=giresearchIPO, 리서치 탐색기 이름 "스몰캡") — 오너 지시 2026-09-27: 비상장으로 분류.
// 게시판 전체가 비상장 리서치라 종목코드 없이 "신한투자증권 비상장리서치" source 로 보낸다.
console.log(`▶ 신한투자증권 비상장분석 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지`);
{
  let uStartId;
  let uStop = false;
  for (let page = 1; page <= MAX_PAGES && !uStop; page++) {
    const data = await fetchPage("giresearchIPO", page, uStartId);
    const list = data.list ?? [];
    if (list.length === 0) break;
    for (const it of list) {
      const date = isoDate(it.f0);
      if (!date) continue;
      if (new Date(date) < cutoff) {
        uStop = true;
        break;
      }
      const title = decodeEntities(String(it.f1 ?? "")).trim();
      if (isCommonExcludedContent(title, "산업")) continue;
      const head = title.match(/^([^;:]+)[;:]/)?.[1]?.replace(/\(\s*비상장[^)]*\)/, "").trim();
      const f2 = String(it.f2 ?? "").trim();
      const name = f2 && f2 !== "-" ? f2 : head || "비상장";
      // 수집 시점 게시판 기준(오너 지시 2026-09-27): 이 게시판에 올라온 글은 그 시점에 비상장이므로 비상장이다.
      // 이후 상장하면 신한 종목(기업분석) 게시판으로 올라와 종목분석으로 받으니 상장사 매칭 휴리스틱은 두지 않는다.
      // (과거 백필분에 상장 이후 발간글이 섞이는 건 일회성 한계 — 향후 수집에는 발생하지 않음.)
      items.push({
        id: String(it.fn),
        date,
        title,
        stockName: name,
        symbol: null,
        analyst: it.f4 ?? "",
        opinion: "",
        targetPrice: null,
        summary: excerpt(it.f7),
        pdfUrl: it.f3 || null,
        views: Number(it.f5) || null,
        category: "산업",
        board: "신한투자증권 > 기업분석 > 비상장분석(giresearchIPO)",
        market: "kr",
        unlisted: true,
      });
    }
    const pages = data.pageInfo?.pages ?? [];
    uStartId = pages.length > 1 ? pages[1] : undefined;
    if (!uStartId) break;
    await sleep(400);
  }
}

if (items.length === 0) {
  console.error("✗ 파싱 결과 0건. 게시판 구조가 바뀌었을 수 있음.");
  // 0건은 실패가 아니다 — 주말·휴일이나 새 글이 없는 날에도 워크플로가 "실패"로
  // 찍혀 진짜 장애를 가리고 로컬 재실행 도구가 헛돌았다(감사 2026-09-28: 일요일
  // 8개 수집기 전부 거짓 실패). 경고만 남기고 정상 종료한다. 파서가 진짜 깨진
  // 경우는 DB 최신 날짜가 며칠째 안 움직이는 것으로 드러난다.
  console.log("::warning::파싱 결과 0건 — 새 글이 없거나 구조가 바뀌었을 수 있음");
  process.exit(0);
}

console.log(`✔ 파싱 완료: ${items.length}건`);
// 투자의견·목표주가 — 공용 추출기(본문 → PDF).
// 업종 리포트의 뭉뚱그린 라벨("산업")을 제목·PDF 표지의 실제 업종명으로 보정(공통 lib) — 안 그러면 제목 키워드로 오분류.
console.log(`▶ 업종 라벨 보정: ${await refineSectorLabels(items)}건`);
await enrichResearch(items, { market: "kr" });
console.log("  최근 3건:", items.slice(0, 3).map((i) => `${i.date} ${i.stockName} — ${i.title}`));

if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

// 비상장 분석(오너 지시 2026-09-27 — "신한투자증권 기업분석 비상장분석은 비상장으로 분류"): 국내 항목 중 종목명·제목에
// "비상장"이 있으면 종목 리포트가 아니라 비상장 리서치로 — source 를 분리해 산업 카테고리·종목코드 없음으로 보낸다.
const UNLISTED_SOURCE = "신한투자증권 비상장리서치";
// 미국·중국도 같다(오너 지시 2026-09-27 — "미국과 중국도 비상장을 추가한다"): 해외 글은 "비상장" 표기가 있거나, 종목 없는 산업 글의 제목이
// IPO 설명서·IPO 프리뷰처럼 상장 전 기업 이야기면 비상장으로. 중국 기업이면 시장을 ch 로 태깅(us 로 합치지 않음).
for (const it of items) {
  const hay = `${it.stockName} ${it.title}`;
  const market = it.market ?? "kr";
  const preIpo = market !== "kr" && it.category === "산업" && !it.symbol && /\bIPO\b/.test(String(it.title));
  // 국내는 기존대로 "비상장" 포함이면 비상장(비상장분석 게시판 등), 해외는 명시 태그만("비상장주식 평가이익" 같은 상장사 글 오탐 방지).
  if (market === "kr" ? /비상장/.test(hay) : isUnlistedCompanyTag(hay) || preIpo) {
    it.unlisted = true;
    it.category = "산업";
    it.symbol = null;
    if (market !== "kr" && /중국|China/i.test(hay)) it.market = "ch";
  }
}

// 같은 제목이 여러 번 올라온 것은 내용 업데이트본이라 최신 1건만 수집한다(오너 지시 2026-09-27).
{
  const latest = new Map();
  for (const it of items) {
    const key = `${it.market ?? "kr"}|${it.category}|${it.stockName}|${String(it.title).replace(/\s+/g, " ").trim()}`;
    const cur = latest.get(key);
    if (!cur || it.date > cur.date || (it.date === cur.date && Number(it.id) > Number(cur.id))) latest.set(key, it);
  }
  if (latest.size !== items.length) {
    console.log(`  동일 제목 중복 ${items.length - latest.size}건 제거(최신만 유지)`);
    const keep = new Set(latest.values());
    for (let i = items.length - 1; i >= 0; i--) if (!keep.has(items[i])) items.splice(i, 1);
  }
}

// 산업분석·해외·투자전략·비상장 병합으로 market/source가 섞이므로 나눠 전송.
const byMarket = new Map();
for (const it of items) {
  const market = it.market ?? "kr";
  const key = `${market}|${it.unlisted ? "u" : ""}`;
  if (!byMarket.has(key)) byMarket.set(key, []);
  byMarket.get(key).push(it);
}

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
  if (VERCEL_BYPASS) headers["x-vercel-protection-bypass"] = VERCEL_BYPASS;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;

for (const [key, group] of byMarket) {
  const [market, u] = key.split("|");
  const up = await fetch(IMPORT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ items: group, source: u ? UNLISTED_SOURCE : "신한투자증권", market }),
  });
  const upBody = await up.text();
  if (!up.ok) {
    console.error(`✗ 앱 전송 실패(market=${market}) HTTP ${up.status}: ${upBody.slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`\n✔ 앱 전송 완료(market=${market}, ${group.length}건): ${upBody}`);
}
