/**
 * 한화투자증권 리서치 — 로컬 수집기(기업·산업·주식전략·경제·채권·해외주식).
 *
 * www.hanwhawm.com 리서치센터 게시판은 로그인 없이 서버렌더 HTML로 나온다.
 * 페이지네이션은 평범한 GET(`list.cmd?depth3_id={게시판}&p=N`, 페이지당 10건).
 * 한경 컨센서스 경유분을 완전히 대체하려고(오너 결정 2026-09-25) 기업분석
 * 하나만 보던 것을 아래 게시판으로 넓혔다. 분류 기준은 삼성증권 수집기와 같다.
 *
 *   | depth3_id | 사이트 분류   | 앱 목적지                                            |
 *   |-----------|---------------|------------------------------------------------------|
 *   | anls1     | 기업분석      | 국내 종목분석("[업종] 종목명[코드/의견] 제목")        |
 *   | anls2     | 산업분석      | 국내 산업분석(대괄호 업종 라벨). 디지털자산·ESG 제외 |
 *   | rpt_m1    | 주식전략      | 국내 산업분석, stockName 고정 "한화 투자전략"        |
 *   | rpt_m8    | 국내외 경제   | 거시경제 이슈분석(FX·환율 글은 환율분석)             |
 *   | istn1     | 채권전략      | 거시경제 이슈분석(FX·환율 글은 환율분석)             |
 *   | anls19    | 해외주식분석  | 미국 종목(us/기업)·중국 종목(ch/기업)·그 외 산업     |
 *
 * rp9·rpt_m3·idea_02 는 휴면 게시판이라 넣지 않았다(실측 2026-09-25).
 *
 * **해외주식분석(anls19) 제목 규칙(실측 2026-09-25, 약 80건)**:
 *  - "[미국주식] NVIDIA Corp. (NVDA) 헤드라인", "[미국주식] 플루언스 에너지(FLNC),
 *    헤드라인" — 괄호 안 티커 → us/기업, symbol=티커.
 *  - "[미국주식] [Earnings Flash] Tapestry, Inc." — 티커가 제목·본문·PDF 어디에도
 *    없다(PDF 의 기업명 칸은 그림). 영문 회사명을 네이버 해외종목 자동완성으로
 *    티커 해석(NH 해외 수집기와 같은 엔드포인트). 이름이 정확히 같거나 미국 후보가
 *    하나뿐일 때만 인정하고, 못 찾으면 종목 없이 us/산업으로 보낸다(C6 — 틀린
 *    티커보다 빈칸).
 *  - "[미국주식] [IPO 101] [스페이스X (SPCX)] …" — 상장 전 기업이라 us/산업.
 *  - "[중국주식] …" — 지금까지는 전부 테마·전략 글(종목 리포트 0건). 종목코드
 *    ("(0700.HK)"·"(688981 CH)")가 있으면 ch/기업, 없으면 ch/산업
 *    (오너 원칙 "ch는 마켓은 ch다 us분류하면 안된다").
 *  - "[해외주식]"·"[해외시황]"·기타 — us/산업.
 *
 * **PDF(오너 결정 2026-09-25)**: 상세 `view.cmd?...&mode=attach_open&seq=N` 에
 * 첨부 링크(`/main/common/common_file/fileView.cmd?category=2&depth3_id=...&key1=
 * {seq}&key2=1&bldid=bbs10031`)가 나오고, 이 링크는 쿠키 없이 200
 * application/pdf 다(실측 — 6개 게시판 모두 같은 형식). 상세 페이지에서 첨부
 * 링크를 파싱해 pdfUrl 로 쓰고, 첨부가 없으면 기존처럼 상세 URL 로 폴백한다.
 * 같은 상세 페이지의 본문(`researchCont`)은 투자의견·목표주가 추출에 쓴다
 * (본문 → PDF 순, 공용 추출기가 필요할 때만 PDF 를 받는다).
 *
 * 새 글 배지 버그(2026-09-25 수정): 새 글은 `</a>` 와 `<p class="cont_txt">`
 * 사이에 `<img src="/img/common/new.gif">` 가 끼는데, 예전 정규식이 이를 허용하지
 * 않아 가장 최근 글을 통째로 놓쳤다.
 *
 * www.hanwhawm.com/robots.txt 는 `/service/`·`/service/cs/` 등 좁은 경로만
 * Disallow 하고 `/main/research/`·`/main/common/common_file/` 은 허용한다
 * (실측 2026-09-25). 그래도 다른 소스와 같은 조건(개인용·저빈도)으로 돌린다.
 * 앱 배포본(Vercel)에는 이 수집 코드가 없다.
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-hanwha-research.mjs
 *   node scripts/collect-hanwha-research.mjs --days=30 --pages=10 --dry-run
 */

import { readFileSync } from "node:fs";
import { enrichResearch, readPdfText } from "./lib/research-extract.mjs";
import { isEtfOrEtpContent, isEsgContent, isCommonExcludedContent, isCommodityContent, isFxContent, isDigitalAssetContent, isUnlistedCompanyTag } from "./lib/exclude-filters.mjs";
import { industryLabelAndHeadline } from "./lib/label-extract.mjs";
import { looksLikeSectorLabel } from "./lib/sector-label.mjs";

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
const MAX_PAGES = Number(ARGS.find((a) => a.startsWith("--pages="))?.split("=")[1]) || 5;

const IMPORT_URL = (
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://macroresearch.vercel.app/api/cron/total-research"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
// Vercel 배포 보호(Vercel Authentication)가 프로덕션에 켜져 있으면 앱에 닿기
// 전에 401 이 난다 — 자동화 우회 비밀값이 있으면 헤더로 같이 보낸다(없으면 생략).
const VERCEL_BYPASS = (ENV.VERCEL_AUTOMATION_BYPASS_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim(); // 로컬 수동 실행 시 CRON_SECRET 없어도 인증 가능(라우트가 x-app-token도 허용)
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const SLEEP_MS = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SITE = "https://www.hanwhawm.com";
const LIST_URL = `${SITE}/main/research/main/list.cmd`;
const VIEW_URL = `${SITE}/main/research/main/view.cmd`;
const SOURCE = "한화투자증권";
const UNLISTED_SOURCE = "한화투자증권 비상장리서치";
// 시장 전체 노트 신호 — 종목·업종이 아니라 시장·유동성·통화정책·지수 얘기(투자전략(주식) 대상).
const MARKET_NOTE_RE = /유동성|FOMC|연준|\bFed\b|금리|정상회담|증시|나스닥|다우|S&P|코스피|지수|셀온|신고가/i;
const STRATEGY_LABEL = "한화 투자전략";

const BOARDS = [
  { id: "anls1", label: "기업분석", kind: "krCompany" },
  { id: "anls2", label: "산업분석", kind: "krIndustry" },
  { id: "rpt_m1", label: "주식전략", kind: "strategy" },
  { id: "rpt_m8", label: "국내외 경제", kind: "macro" },
  { id: "istn1", label: "채권전략", kind: "macro" },
  { id: "anls19", label: "해외주식분석", kind: "overseas" },
];

const isoDate = (s) => {
  const m = String(s).trim().match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};
const EXCERPT_LEN = 300;
function excerpt(text) {
  const flat = String(text ?? "").replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ").trim();
  return flat.length > EXCERPT_LEN ? `${flat.slice(0, EXCERPT_LEN)}…` : flat;
}
function stripHtml(s) {
  return String(s ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function fetchPage(boardId, page) {
  const url = new URL(LIST_URL);
  url.searchParams.set("depth3_id", boardId);
  url.searchParams.set("mode", "");
  url.searchParams.set("viewclass", "");
  url.searchParams.set("p", String(page));
  return fetchText(url);
}

const detailUrl = (boardId, seq) => `${VIEW_URL}?depth3_id=${boardId}&mode=&seq=${seq}&p=`;
const attachUrl = (boardId, seq) => `${VIEW_URL}?depth3_id=${boardId}&mode=attach_open&seq=${seq}`;

// 상세(attach_open) — 본문(researchCont)과 첨부 PDF 링크. 실패하면 빈 값.
const FILE_LINK_RE = /href="(\/main\/common\/common_file\/fileView\.cmd\?[^"]+)"[^>]*>[\s\S]{0,200}?\.pdf/i;
async function fetchDetail(boardId, seq) {
  try {
    const html = await fetchText(attachUrl(boardId, seq));
    const start = html.indexOf('class="researchCont"');
    const end = html.indexOf('class="researchAttach"', start);
    const body = start >= 0 ? stripHtml(html.slice(start + 20, end > start ? end : start + 50_000)) : "";
    const link = html.match(FILE_LINK_RE)?.[1]?.replace(/&amp;/g, "&");
    return { body, pdfUrl: link ? `${SITE}${link}` : null };
  } catch (err) {
    console.warn(`  ⚠ 상세 조회 실패 (${boardId}:${seq}): ${err.message}`);
    return { body: "", pdfUrl: null };
  }
}

// 항목 하나 = view('seq','depth3_id','게시판명') 앵커 + (새 글 배지) + 요약(cont_txt)
// + 카테고리/작성자/날짜. 새 글 배지(new.gif)가 </a> 뒤에 끼는 경우를 허용한다.
const ITEM_RE =
  /<a href="javascript:view\('(\d+)', '(\w+)', '[^']*'\);"\s*>\s*([^<]+?)\s*<\/a>\s*((?:<img[^>]*>\s*)*)<p class="cont_txt">([\s\S]*?)<\/p>[\s\S]{0,200}?<span class="gubun">([^<]*)<\/span>\s*([^<]*?)\s*<span class="date">([\d.]+)<\/span>/g;

function parseList(html) {
  const rows = [];
  for (const m of html.matchAll(ITEM_RE)) {
    const [, seq, board, rawTitle, badges, rawSummary, , analyst, rawDate] = m;
    const date = isoDate(rawDate);
    if (!date) continue;
    rows.push({
      seq,
      board,
      date,
      title: stripHtml(rawTitle),
      summaryText: stripHtml(rawSummary),
      analyst: analyst.trim(),
      newBadge: /new\.gif/.test(badges),
    });
  }
  return rows;
}

// ── 제목 규칙 ─────────────────────────────────────────────────────────
// 기업분석: "[업종] 종목명[코드/의견] 나머지" — 업종 태그는 먼저 떼어낸다.
const SECTOR_TAG_RE = /^\[[^\]]+\]\s*/;
const KR_TITLE_RE = /^(.+?)\[(\d{6}[A-Z0-9]*)\/([^\]]+)\]\s*(.+)$/;
// 해외주식분석 지역 태그: "[미국주식] …"·"미국주식 […]"(대괄호 누락 실측 1건).
const REGION_RE = /^\[?(미국주식|중국주식|해외주식|해외시황)\]?\s*/;
// "NVIDIA Corp. (NVDA) 헤드라인" / "플루언스 에너지(FLNC), 헤드라인"
const US_TICKER_RE = /^([^[\]]+?)\s*\(([A-Z]{1,5}(?:\.[A-Z])?)\)\s*[,:：]?\s*(.+)$/;
// 중국 종목: "텐센트 (0700.HK) 헤드라인" / "SMIC (688981 CH) 헤드라인"
const CH_TICKER_RE = /^([^[\]]+?)\s*\((\d{4,6})[.\s](HK|CH|SH|SZ)\)\s*[,:：]?\s*(.+)$/i;
const EARNINGS_FLASH_RE = /^\[Earnings Flash\]\s*(.+)$/i;
const IPO_RE = /\[IPO\b|\bIPO 101\b/i;

/** 영문 회사명 → 미국 티커(네이버 해외종목 자동완성). 확실할 때만, 실패하면 null. */
const COMPANY_SUFFIX_RE =
  /(?:,?\s+(?:Inc\.?|lnc\.?|Corp\.?|Corporation|plc|N\.?V\.?|Co\.?|Company|Ltd\.?|Limited|ADR|S\.?A\.?))+\s*$/i;
const cleanCompany = (n) => String(n ?? "").replace(COMPANY_SUFFIX_RE, "").trim();
const normCompany = (n) => cleanCompany(n).toLowerCase().replace(/[^a-z0-9가-힣]/g, "");
const usCache = new Map();
async function resolveUsTicker(name) {
  const q = cleanCompany(name);
  if (!q) return null;
  if (usCache.has(q)) return usCache.get(q);
  let hit = null;
  try {
    const res = await fetch(`https://ac.stock.naver.com/ac?q=${encodeURIComponent(q)}&target=stock`, {
      headers: { "User-Agent": UA, accept: "application/json" },
    });
    if (res.ok) {
      const us = ((await res.json()).items ?? []).filter(
        (i) => i.nationCode === "USA" && /^[A-Z]{1,5}(?:\.[A-Z])?$/.test(String(i.code)),
      );
      // 이름이 정확히 같거나(접미어 제외) 미국 후보가 하나뿐일 때만 인정.
      const found = us.find((i) => normCompany(i.name) === normCompany(q)) ?? (us.length === 1 ? us[0] : null);
      if (found) hit = String(found.code).toUpperCase();
    }
  } catch {
    /* 무시 — 종목 없이 산업으로 */
  }
  usCache.set(q, hit);
  await sleep(SLEEP_MS);
  return hit;
}

function baseItem(row) {
  return {
    id: row.board === "anls1" ? row.seq : `${row.board}:${row.seq}`, // anls1 은 기존 id(seq) 호환
    date: row.date,
    analyst: row.analyst,
    opinion: "",
    targetPrice: null,
    summary: excerpt(row.summaryText),
    pdfUrl: detailUrl(row.board, row.seq),
    views: null,
    board: row.board,
    seq: row.seq,
    newBadge: row.newBadge,
  };
}

function industryItem(base, title, market) {
  const { label, headline } = industryLabelAndHeadline(title);
  return { ...base, title: headline || title, stockName: label, symbol: null, category: "산업", market, source: SOURCE };
}

// 리서치 분류 체계 전면 개편(2026-09-26)으로 macro_issues 컬렉션 폐지 — 고정
// stockName(shinhan-research.ts FORCED_ISSUE_STOCKNAMES/FORCED_FX_STOCKNAMES
// 등록)으로 kr_research에 합류시킨다.
function macroItem(base, title, label) {
  const isFx = isFxContent(title);
  return { ...base, title, stockName: isFx ? `${label} FX` : label, symbol: null, category: "산업", market: "kr", source: SOURCE };
}
function commodityItem(base, title, market = "kr") {
  const isFx = isFxContent(title);
  return {
    ...base,
    title,
    stockName: isFx ? "한화 원자재 FX" : "한화 원자재",
    symbol: null,
    category: "산업",
    market,
    source: SOURCE,
  };
}

/** 게시판·제목 → 전송 항목. null 이면 제외. */
async function classify(row, board) {
  const base = baseItem(row);
  const title = row.title;

  if (board.kind === "krCompany") {
    const tm = title.replace(SECTOR_TAG_RE, "").match(KR_TITLE_RE);
    // "조사분석자료 공표중단 종목" 같은 공지는 종목 리포트가 아니다(실측 2026-09-04).
    if (!tm) return null;
    return {
      ...base,
      title,
      stockName: tm[1].trim(),
      symbol: tm[2].slice(0, 6),
      opinion: tm[3].trim(),
      opinionFrom: "title", // "종목명[코드/의견]" 제목 — 공용 추출기 C2 검증 제외
      category: "기업",
      market: "kr",
      source: SOURCE,
    };
  }
  if (board.kind === "macro") {
    const label = board.id === "istn1" ? "한화 채권전략" : "한화 국내외경제";
    return macroItem(base, title, label);
  }

  // 여기부터 종목이 아닌 글이 섞이는 게시판 — 원자재는 이슈분석으로.
  if (board.kind === "krIndustry") {
    if (isDigitalAssetContent(title)) return null; // 이 게시판은 국내 전용(market:"kr")
    if (isCommodityContent(title)) return commodityItem(base, title);
    return industryItem(base, title, "kr");
  }
  if (board.kind === "strategy") {
    if (isCommodityContent(title)) return commodityItem(base, title);
    return { ...base, title, stockName: STRATEGY_LABEL, symbol: null, category: "산업", market: "kr", source: SOURCE };
  }

  // overseas(anls19)
  const region = title.match(REGION_RE)?.[1] ?? "";
  const rest = title.replace(REGION_RE, "").trim();
  const market = region === "중국주식" ? "ch" : "us";
  if (!IPO_RE.test(rest)) {
    const cm = rest.match(CH_TICKER_RE);
    if (cm) {
      return {
        ...base,
        title: cm[4].trim(),
        stockName: cm[1].trim(),
        symbol: `${cm[2]}.${cm[3].toUpperCase()}`,
        category: "기업",
        market: "ch",
        source: SOURCE,
      };
    }
    if (market === "us") {
      const um = rest.match(US_TICKER_RE);
      if (um) {
        return { ...base, title: um[3].trim(), stockName: um[1].trim(), symbol: um[2], category: "기업", market, source: SOURCE };
      }
      const ef = rest.match(EARNINGS_FLASH_RE);
      if (ef) {
        const company = ef[1].trim();
        const symbol = await resolveUsTicker(company);
        if (symbol) {
          return { ...base, title: `[Earnings Flash] ${company}`, stockName: company, symbol, category: "기업", market, source: SOURCE, resolvedBy: "naver" };
        }
        return { ...base, title: `[Earnings Flash] ${company}`, stockName: company, symbol: null, category: "산업", market, source: SOURCE, unresolved: true };
      }
    }
  }
  if (isCommodityContent(title)) return commodityItem(base, title, market);
  const it = industryItem(base, rest || title, market);
  // 상장 전 기업 리포트("[IPO 101] [스페이스X (SPCX)] …")는 비상장 리서치(오너 지시 2026-09-27 — 미국·중국도 비상장 추가).
  if (IPO_RE.test(rest) || isUnlistedCompanyTag(rest)) {
    it.source = UNLISTED_SOURCE;
    return it;
  }
  // 대괄호·콜론 라벨이 없으면 지역 태그를 라벨로.
  // "[해외시황]"(박제인, 해외 시장 이슈·자금조달 등)은 일간 시황이 아니라 이슈분석 — 고정 라벨로 붙여 앱이 거시경제
  // 이슈분석으로 분류(오너 지시 2026-09-27, "AI 자금조달, 넓어지는 시장과 높아지는 비용").
  if (region === "해외시황") it.stockName = "한화 해외시황";
  else if (it.stockName === "산업" && region) it.stockName = region;
  // 종목도 업종도 없는 미국·중국 시장 노트("[미국주식] 호르무즈보다 중요한 건 유동성", "[미중 정상회담] 높아질 기대, 숨 고를 증시")는
  // 산업분석이 아니라 투자전략(주식)이다(오너 지적 2026-09-27). 라벨이 실제 업종 어휘일 때만 산업분석으로 남긴다.
  // 제목에 시장 전체 신호(유동성·FOMC·증시·지수 등)가 있을 때만 — 90일 실측에서 종목·업종 글(알리바바 2분기 실적, CXMT 메모리, 정유주)도
  // 종목 없는 미국·중국 글이라 통째로 전략으로 끌려가서 좁혔다.
  if (!it.symbol && it.category === "산업" && (region === "미국주식" || region === "중국주식") && MARKET_NOTE_RE.test(rest)) {
    const label = it.stockName === region ? "" : it.stockName;
    if (!looksLikeSectorLabel(label)) it.stockName = "한화 해외주식 전략";
  }
  return it;
}

// ── 수집 ──────────────────────────────────────────────────────────────
console.log(`▶ 한화투자증권 리서치 수집(${BOARDS.map((b) => b.label).join("·")}): 최근 ${DAYS}일, 게시판당 최대 ${MAX_PAGES}페이지`);
// 항목 날짜가 'YYYY-MM-DD'(=UTC 자정)라 컷오프도 자정으로 맞춘다.
// Date.now() 기준 그대로 두면 '정확히 DAYS일 전' 리포트가 시:분 차이로
// 매번 잘려나간다(실측 2026-09: 미래에셋 최신 리포트가 3시간 차이로 탈락).
const cutoff = new Date(new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10));

const collected = [];
const stats = {};
for (const board of BOARDS) {
  const st = (stats[board.id] = { listed: 0, newBadge: 0, excluded: 0, kept: 0 });
  let stop = false;
  for (let page = 1; page <= MAX_PAGES && !stop; page++) {
    const rows = parseList(await fetchPage(board.id, page));
    await sleep(SLEEP_MS);
    if (rows.length === 0) break;
    for (const row of rows) {
      if (new Date(row.date) < cutoff) {
        stop = true;
        break;
      }
      st.listed++;
      if (row.newBadge) st.newBadge++;
      // 공용 제외 — ETF/ETP·ESG·주간물·일정표·추천종목·원자재 외 대체투자.
      const isStock = board.kind === "krCompany";
      if (
        isEtfOrEtpContent(row.title) ||
        isEsgContent(row.title) ||
        isCommonExcludedContent(row.title, isStock ? "기업" : undefined) ||
        // "[EPS LIVE #N]" 주간 이익 예상치 정기 자료 — 수집 제외(오너 지시 2026-09-26).
        /EPS\s*LIVE/i.test(row.title) ||
        // "월간지수전망 — 9월" 주요 6대 지수 전망(글로벌리서치팀) — 수집 제외(오너 지시 2026-09-26).
        /월간\s*지수\s*전망/.test(row.title) ||
        // "[MP전략] [2026 #N] ..." 모델포트폴리오 정기 자료 — 수집 제외(오너 지시 2026-09-26).
        /^\s*\[MP전략\]/.test(row.title)
      ) {
        st.excluded++;
        continue;
      }
      const it = await classify(row, board);
      if (!it) {
        st.excluded++;
        continue;
      }
      st.kept++;
      collected.push(it);
    }
  }
  console.log(
    `  ${board.label}(${board.id}): 기간 내 ${st.listed}건(새 글 배지 ${st.newBadge}) · 제외 ${st.excluded} · 수집 ${st.kept}`,
  );
}

if (collected.length === 0) {
  console.error("✗ 파싱 결과 0건. 페이지 구조가 바뀌었을 수 있음.");
  // 0건은 실패가 아니다 — 주말·휴일이나 새 글이 없는 날에도 워크플로가 "실패"로
  // 찍혀 진짜 장애를 가리고 로컬 재실행 도구가 헛돌았다(감사 2026-09-28: 일요일
  // 8개 수집기 전부 거짓 실패). 경고만 남기고 정상 종료한다. 파서가 진짜 깨진
  // 경우는 DB 최신 날짜가 며칠째 안 움직이는 것으로 드러난다.
  console.log("::warning::파싱 결과 0건 — 새 글이 없거나 구조가 바뀌었을 수 있음");
  process.exit(0);
}

// 상세(attach_open) — 첨부 PDF 링크 + 본문. 항목마다 1회.
console.log(`▶ 상세 페이지(첨부 PDF 링크·본문) 조회 중 (${collected.length}건)...`);
let pdfLinked = 0;
for (const it of collected) {
  const d = await fetchDetail(it.board, it.seq);
  await sleep(SLEEP_MS);
  if (d.pdfUrl) {
    it.pdfUrl = d.pdfUrl;
    pdfLinked++;
  } else {
    it.noPdf = true; // 상세 URL 폴백 — 추출기가 HTML 을 PDF 로 받지 않게
  }
  if (it.category === "기업") it.bodyText = d.body;
  if (!it.summary && d.body) it.summary = excerpt(d.body);
}
console.log(`  PDF 첨부 링크 ${pdfLinked}/${collected.length}건 (나머지는 상세 URL 폴백)`);

const research = collected;

// "[해외시황]"(박제인) 글의 기본 분류는 시황분석(투자전략)이고, 채권·회사채·크레딧 등 채권 관련 내용이면 이슈분석(채권)이다
// (오너 지시 2026-09-27 — "기본은 투자전략이다. 채권과 관련내용이 이슈분석 채권"). 채권 여부는 제목에 안 드러나
// (예: "AI 자금조달, 넓어지는 시장과 높아지는 비용" — 본문이 회사채 발행 얘기) PDF 첫 쪽의 채권 계열어 개수로 본다
// (실측: 해당 글 36개, 지수 전망·중국주식·이.글.스. 0~1개).
const BOND_WORDS_RE = /채권|회사채|국채|크레딧|스프레드|공모채|신용/g;
for (const it of research) {
  if (it.stockName !== "한화 해외시황" || !it.pdfUrl || it.noPdf) continue;
  const first = String(await readPdfText(it.pdfUrl).catch(() => "")).split(/-- 1 of \d+ --/)[0].slice(0, 2500);
  if ((first.match(BOND_WORDS_RE) ?? []).length >= 5) it.stockName = "한화 해외시황 채권";
}

// 투자의견·목표주가 — 공용 추출기(본문 → 필요할 때만 PDF).
const stockItems = research.filter((it) => it.category === "기업");
// "3.6만원" 같은 소수 만원 표기는 공용 추출기가 아직 못 읽는다 — 건수만 센다.
const DECIMAL_MANWON_RE = /목표\s*주가[^\d\n]{0,15}\d+\.\d+\s*만\s*원/;
const decimalManwon = stockItems.filter((it) => it.market === "kr" && DECIMAL_MANWON_RE.test(`${it.summary}\n${it.bodyText ?? ""}`));
const pdfHold = new Map();
for (const it of stockItems) {
  if (it.noPdf) {
    pdfHold.set(it, it.pdfUrl);
    it.pdfUrl = null;
  }
}
console.log(`▶ 투자의견/목표주가 조회 중 — ${stockItems.length}건...`);
await enrichResearch(stockItems, { sleepMs: SLEEP_MS, usePdf: true });
for (const [it, url] of pdfHold) it.pdfUrl = url;
const decimalMissing = decimalManwon.filter((it) => it.targetPrice == null).length;
console.log(`  소수 만원 표기("3.6만원") 본문 ${decimalManwon.length}건 — 그중 목표가 빈칸 ${decimalMissing}건`);

console.log(`✔ 수집 완료: ${research.length}건`);
const resolved = research.filter((it) => it.resolvedBy === "naver").length;
const unresolved = research.filter((it) => it.unresolved).length;
if (resolved || unresolved) console.log(`  Earnings Flash 티커 해석: 성공 ${resolved} · 실패(산업으로) ${unresolved}`);
for (const i of collected) {
  const dest = `${i.market}/${i.category}`;
  const who = i.symbol ?? i.stockName ?? "";
  const op = i.opinion || i.targetPrice != null ? ` (${i.opinion || "-"}/${i.targetPrice ?? "-"})` : "";
  const pdf = i.noPdf ? " [PDF없음]" : "";
  console.log(`  [${i.board}→${dest}] ${i.date} ${who}${op} — ${i.title} [${i.analyst}]${pdf}${i.newBadge ? " ★new" : ""}`);
}

if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
  if (VERCEL_BYPASS) headers["x-vercel-protection-bypass"] = VERCEL_BYPASS;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;

async function post(url, payload, label, count) {
  const up = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
  const upBody = await up.text();
  if (!up.ok) {
    console.error(`✗ [${label}] 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`✔ [${label}] 앱 전송 완료 (${count}건): ${upBody}`);
}

// 라우트가 POST 1회당 source·market 하나만 받으므로 묶어서 나눠 전송.
const groups = new Map();
for (const it of research) {
  const key = `${it.source}|${it.market}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push({
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
    // 원 게시판(사이트 메뉴) — 대조·검수용. it.board 는 depth3_id.
    board: `한화투자증권 > ${BOARDS.find((b) => b.id === it.board)?.label ?? it.board}(${it.board})`,
  });
}
for (const [key, items] of groups) {
  const [source, market] = key.split("|");
  await post(IMPORT_URL, { items, source, market }, `${source}/${market}`, items.length);
}
