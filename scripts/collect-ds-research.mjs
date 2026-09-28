/**
 * DS투자증권 리서치 수집기 (국내 + 미국).
 *
 * www.ds-sec.co.kr 은 그누보드 게시판이라 로그인 없이 서버렌더 HTML 이 나온다
 * (오너가 URL 제시, 2026-09).
 *   - sub03_02 기업분석        → 국내 종목
 *   - sub03_03 투자전략/경제분석 → 미국 종목이 여기 섞여 있다(오너 확인)
 *
 * 종목 식별이 이 소스의 까다로운 점이다 — 제목에 종목코드도 티커도 없다.
 *   국내: "[섹터] 종목명 - 부제" / "[섹터] 종목명 부제" 처럼 형식이 일정치 않아
 *         corpcodes.json(3,930개) 에서 "제목이 그 이름으로 시작하는 것 중 가장
 *         긴 이름"을 찾는다. 못 찾으면 종목 리포트가 아닌 것으로 보고 건너뛴다
 *         (Defense Daily·Macro Issue 등이 같은 게시판에 섞여 있음).
 *   미국: "[DS 미국주식] 엔비디아: 제목" 처럼 한글 종목명만 있어 네이버 해외종목
 *         자동완성으로 티커를 해석한다(뉴스 쪽에서 이미 쓰는 엔드포인트).
 *
 * ⚠️ 다른 예외들과 동일 조건: 개인용·하루 1회·저빈도(CLAUDE.md 참고).
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-ds-research.mjs
 *   node scripts/collect-ds-research.mjs --days=90 --dry-run
 */

import { readFileSync } from "node:fs";
import { enrichResearch, readPdfText } from "./lib/research-extract.mjs";
import { resolveKrStock } from "./lib/company-match.mjs";
import { isCommonExcludedContent } from "./lib/exclude-filters.mjs";
import { refineSectorLabels, normalizeSectorLabel } from "./lib/sector-label.mjs";

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

const BOARD_URL = "https://www.ds-sec.co.kr/bbs/board.php";
// 리포트가 원래 있던 게시판(상단 주석의 bo_table) — item 의 board 필드(분류 대조용).
const BOARD_LABEL = {
  sub03_02: "DS투자증권 > 리서치 > 기업분석(sub03_02)",
  sub03_03: "DS투자증권 > 리서치 > 투자전략/경제분석(sub03_03)",
};
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

// 국내 종목명 → 코드는 공통 lib 를 쓴다. 예전엔 여기 startsWith 만 있는 복사본이
// 있어서 "신흥국 통화 약세…"→신흥(004080), "LG그룹 지배구조…"→LG, "SK온 상장…"→SK
// 처럼 접두어가 겹치는 종목에 기업 리포트가 잘못 붙었다(감사 2026-09-28). 한경
// 수집기에서 고친 조사·구두점 경계 검사가 담긴 resolveKrStock 을 공유한다.

/** 한글 종목명 → 미국 티커(네이버 해외종목 자동완성). 실패하면 null. */
const usCache = new Map();
async function resolveUsTicker(name) {
  const key = name.trim();
  if (usCache.has(key)) return usCache.get(key);
  let hit = null;
  try {
    const res = await fetch(
      `https://ac.stock.naver.com/ac?q=${encodeURIComponent(key)}&target=stock`,
      { headers: { "User-Agent": UA, accept: "application/json" } },
    );
    if (res.ok) {
      const items = (await res.json()).items ?? [];
      const m = items.find((i) => i.nationCode === "USA" && i.name?.trim() === key) ??
        items.find((i) => i.nationCode === "USA");
      if (m?.code) hit = { symbol: String(m.code).toUpperCase(), stockName: m.name ?? key };
    }
  } catch {
    /* 무시 */
  }
  usCache.set(key, hit);
  await sleep(300);
  return hit;
}

async function fetchBoard(table, page) {
  const url = new URL(BOARD_URL);
  url.searchParams.set("bo_table", table);
  if (page > 1) url.searchParams.set("page", String(page));
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

const stripHtml = (s) =>
  String(s ?? "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

function parseRows(html) {
  const rows = [];
  for (const chunk of html.split(/<tr[^>]*>/).slice(1)) {
    const idM = chunk.match(/wr_id=(\d+)/);
    const titM = chunk.match(/<div class="bo_tit">\s*<a[^>]*>([\s\S]*?)<\/a>/);
    const dateM = chunk.match(/<td class="td_datetime">\s*(\d{4}-\d{2}-\d{2})\s*<\/td>/);
    if (!idM || !titM || !dateM) continue;
    rows.push({ id: idM[1], title: stripHtml(titM[1]), date: dateM[1] });
  }
  return rows;
}

/** "[섹터] 나머지" 에서 대괄호 머리말을 떼고 본문만 남긴다. */
function stripBracket(title) {
  const m = title.match(/^\[[^\]]*\]\s*(.+)$/);
  return m ? m[1].trim() : title.trim();
}

/** 산업분석/투자전략(2026-09 추가, 오너 지시 — "한국과 미국 모두 동일하게
 * 수집 기반 구축"): 종목 매칭에 실패한 나머지(Defense Daily·Macro Issue·
 * 투자전략·퀀트 노트 등)를 버리지 않고 대괄호 태그를 업종/주제 라벨로 써서
 * 수집한다. "[미국 데이터센터 ...균열]"처럼 본문 전체가 대괄호 안에 있어
 * 태그 뒤에 남는 게 없으면 라벨을 "산업"으로 두고 대괄호 안 전체를 제목으로 쓴다. */
function bracketLabelAndRest(title) {
  const m = title.match(/^\[([^\]]*)\]\s*(.*)$/);
  if (!m) return { label: "산업", rest: title.trim() };
  const rest = m[2].trim();
  // "[DS 경제 서동화] Macro Issue …"(경제 담당 애널리스트 이름이 붙은 라벨)는 애널리스트 이름을 떼고 "DS 경제"로 고정 — 앱이 거시경제
  // 이슈분석(경제)으로 분류한다(오너 지시 2026-09-27, "FOMC면 경제가 맞다").
  // (한글 뒤에서는 \b 단어 경계가 동작하지 않아 "경제" 다음이 공백/끝인지를 lookahead 로 본다.)
  // 애널리스트 이름이 라벨로 온 경우("[매태호] …")는 공통 정규화(normalizeSectorLabel)가 담당 업종으로 바꾼다.
  const label0 = m[1].trim();
  const rawLabel = /^DS\s*경제(?=\s|$)/.test(label0) ? "DS 경제" : label0;
  return rest ? { label: normalizeSectorLabel(rawLabel), rest } : { label: "산업", rest: m[1].trim() };
}

console.log(`▶ DS투자증권 리서치 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지`);
const cutoff = new Date(new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10));

async function collectBoard(table) {
  const out = [];
  let stop = false;
  for (let page = 1; page <= MAX_PAGES && !stop; page++) {
    const rows = parseRows(await fetchBoard(table, page));
    if (rows.length === 0) break;
    for (const r of rows) {
      if (new Date(r.date) < cutoff) {
        stop = true;
        break;
      }
      out.push(r);
    }
    await sleep(400);
  }
  return out;
}

const krRows = await collectBoard("sub03_02");
const usRows = await collectBoard("sub03_03");
console.log(`  목록 — 기업분석 ${krRows.length}건 · 투자전략/경제분석 ${usRows.length}건`);

const krItems = [];
const usItems = []; // sub03_03 미국·글로벌 항목 + sub03_02 에 올라온 미국 이야기("[미국 …]")
for (const r of krRows) {
  const body = stripBracket(r.title);
  const hit = resolveKrStock(body);
  if (hit) {
    krItems.push({
      id: r.id,
      date: r.date,
      title: body.slice(hit.stockName.length).replace(/^[\s\-–—:,]+/, "").trim() || body,
      stockName: hit.stockName,
      symbol: hit.symbol,
      analyst: "",
      opinion: "",
      targetPrice: null,
      summary: "",
      pdfUrl: `https://www.ds-sec.co.kr/bbs/board.php?bo_table=sub03_02&wr_id=${r.id}`,
      board: BOARD_LABEL.sub03_02,
      views: null,
      category: "기업",
    });
    continue;
  }
  // Defense Daily·거버넌스 시리즈·섹터 전략 노트 등 종목 리포트가 아닌 것 —
  // 산업분석/투자전략으로 별도 수집(symbol 항상 null).
  const { label, rest } = bracketLabelAndRest(r.title);
  const pdfUrl2 = `https://www.ds-sec.co.kr/bbs/board.php?bo_table=sub03_02&wr_id=${r.id}`;
  // "[미드스몰캡] 세미티에스 - 반도체 생산성 개선의 숨은 조력자"는 업종 글이 아니라 종목 코멘트다(오너 지적 2026-09-27 — "아무리봐도
  // 종목인데") — "종목명 - 부제" 형식이면 기업으로 올린다. 종목 목록에 없는 신규 종목은 symbol 없이(서버 이름 검색에 맡김).
  const sm = label === "미드스몰캡" ? rest.match(/^(.+?)\s+-\s+(.+)$/) : null;
  if (sm) {
    const corp = CORPS.find((c) => c.n === sm[1].trim());
    krItems.push({
      id: r.id, date: r.date, title: sm[2].trim(), stockName: sm[1].trim(), symbol: corp?.s ?? null,
      analyst: "", opinion: "", targetPrice: null, summary: "", pdfUrl: pdfUrl2, board: BOARD_LABEL.sub03_02, views: null, category: "기업",
    });
    continue;
  }
  // 대괄호 안이 제목 전체이고 "미국 …"으로 시작하면(예: "[미국 데이터센터 전력망 비용 부담 현실화, ‘All of the Above’의 균열]") 미국 산업분석 —
  // 국내 기업분석 게시판에 올라와도 시장은 미국이다(오너 지적 2026-09-27 — "아무리봐도 미국인데").
  if (label === "산업" && /^미국\s/.test(rest)) {
    usItems.push({
      id: r.id, date: r.date, title: rest, stockName: label, symbol: null,
      analyst: "", opinion: "", targetPrice: null, summary: "", pdfUrl: pdfUrl2, board: BOARD_LABEL.sub03_02, views: null, category: "산업", market: "us",
    });
    continue;
  }
  krItems.push({
    id: r.id,
    date: r.date,
    title: rest,
    stockName: label,
    symbol: null,
    analyst: "",
    opinion: "",
    targetPrice: null,
    summary: "",
    pdfUrl: `https://www.ds-sec.co.kr/bbs/board.php?bo_table=sub03_02&wr_id=${r.id}`,
    board: BOARD_LABEL.sub03_02,
    views: null,
    category: "산업",
  });
}

// 산업분석/투자전략(2026-09 추가): 이 게시판은 원래 이름 그대로 "투자전략/
// 경제분석"이라 종목 매칭에 실패한(또는 애초에 종목 얘기가 아닌) 대다수
// 글이 Macro Issue·투자전략·퀀트 노트 등 산업분석/투자전략 콘텐츠다(오너가
// 애초에 "ds는 종목리서치는 gm으로, 산업분석은 ds검색기로" 결정한 이유와도
// 부합). "미국주식/글로벌주식" 태그가 있으면 미국 산업분석(market:"us"),
// 그 외(국내 매크로·전략)는 한국 산업분석(market:"kr")으로 분류한다.
for (const r of usRows) {
  const isUsTagged = /미국주식|글로벌주식/.test(r.title);
  if (isUsTagged) {
    const body = stripBracket(r.title);
    const nameM = body.match(/^([^:：]{2,20})\s*[:：]\s*(.+)$/);
    const hit = nameM ? await resolveUsTicker(nameM[1]) : null;
    if (hit) {
      usItems.push({
        id: r.id,
        date: r.date,
        title: nameM[2].trim(),
        stockName: hit.stockName,
        symbol: hit.symbol,
        analyst: "",
        opinion: "",
        targetPrice: null,
        summary: "",
        pdfUrl: `https://www.ds-sec.co.kr/bbs/board.php?bo_table=sub03_03&wr_id=${r.id}`,
        board: BOARD_LABEL.sub03_03,
        views: null,
        category: "기업",
        market: "us",
      });
      continue;
    }
  }
  const { label, rest } = bracketLabelAndRest(r.title);
  usItems.push({
    id: r.id,
    date: r.date,
    title: rest,
    stockName: label,
    symbol: null,
    analyst: "",
    opinion: "",
    targetPrice: null,
    summary: "",
    pdfUrl: `https://www.ds-sec.co.kr/bbs/board.php?bo_table=sub03_03&wr_id=${r.id}`,
    board: BOARD_LABEL.sub03_03,
    views: null,
    category: "산업",
    market: isUsTagged ? "us" : "kr",
  });
}

// 공통 배제(오너 지시 2026-09-25) — push 지점이 여러 곳이라 완성된 배열에서 한 번에 거른다.
function pruneExcluded(arr) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (isCommonExcludedContent(`${arr[i].stockName} ${arr[i].title}`, arr[i].category)) arr.splice(i, 1);
    // "DS Defense Daily" 방산 일간 시리즈 — 수집 제외(오너 지시 2026-09-27).
    else if (/Defense\s*Daily/i.test(arr[i].stockName ?? "")) arr.splice(i, 1);
  }
}
pruneExcluded(krItems);
pruneExcluded(usItems);

console.log(`✔ 종목 매핑 — 국내 ${krItems.length}건 · 미국 ${usItems.length}건`);
if (krItems.length + usItems.length === 0) {
  console.error("✗ 파싱 결과 0건. 게시판 구조가 바뀌었을 수 있음.");
  process.exit(1);
}
console.log("  국내 예시:", krItems.slice(0, 3).map((i) => `${i.date} ${i.stockName}(${i.symbol})`));
console.log("  미국 예시:", usItems.slice(0, 3).map((i) => `${i.date} ${i.stockName}(${i.symbol})`));

// 투자의견·목표주가 — 종목 리포트만 첨부 PDF 를 읽어 공용 추출기에 넘긴다.
// 그누보드 첨부(download.php)는 게시글을 먼저 열어 받은 세션 쿠키가 있어야
// PDF 가 나온다(쿠키 없으면 "오류안내" HTML, 실측 2026-09-25) — 로그인은 불필요.
// 목록 링크(pdfUrl)는 그대로 게시글 주소로 둔다.
async function readDsAttachmentText(postUrl) {
  try {
    const view = await fetch(postUrl, { headers: { "User-Agent": UA } });
    const cookie = (view.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    const html = await view.text();
    const m = html.match(/href="([^"]*\/bbs\/download\.php\?[^"]+)"/);
    if (!m) return "";
    return await readPdfText(m[1].replace(/&amp;/g, "&"), { headers: { cookie, referer: postUrl } });
  } catch {
    return "";
  }
}
const stockItems = [...krItems, ...usItems].filter((it) => it.category === "기업");
console.log(`▶ 투자의견/목표주가 조회 중 (첨부 PDF) — ${stockItems.length}건...`);
for (const it of stockItems) {
  it.pdfText = await readDsAttachmentText(it.pdfUrl);
  await sleep(400);
}
for (const it of krItems) it.market ??= "kr";
// 업종 리포트의 뭉뚱그린 라벨("산업")을 제목·PDF 표지의 실제 업종명으로 보정(공통 lib) — 안 그러면 제목 키워드로 오분류.
console.log(`▶ 업종 라벨 보정: ${await refineSectorLabels([...krItems, ...usItems])}건`);
await enrichResearch([...krItems, ...usItems], { usePdf: false });

if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
  if (VERCEL_BYPASS) headers["x-vercel-protection-bypass"] = VERCEL_BYPASS;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;

// usRows(sub03_03)에서 나온 항목은 market이 "kr"/"us" 로 섞여 있을 수 있어
// (투자전략/경제분석 게시판이 국내 매크로도 다룸) 실제 market 값 기준으로
// 재구성한다. krItems(sub03_02)는 항상 국내다.
const usOnly = usItems.filter((it) => it.market === "us");
const krFromUsBoard = usItems.filter((it) => it.market !== "us");
for (const [market, items] of [
  ["kr", [...krItems, ...krFromUsBoard]],
  ["us", usOnly],
]) {
  if (items.length === 0) continue;
  const up = await fetch(IMPORT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ items, source: "DS투자증권", market }),
  });
  const body = await up.text();
  if (!up.ok) {
    console.error(`✗ [${market}] 전송 실패 HTTP ${up.status}: ${body.slice(0, 200)}`);
    continue;
  }
  console.log(`✔ [${market}] ${items.length}건 전송: ${body}`);
}
