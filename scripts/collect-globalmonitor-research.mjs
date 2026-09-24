/**
 * GlobalMonitor(einfomax.co.kr) — 한국 증권사들의 "미국주식" 리포트 통합 수집기.
 *
 * 오너가 `https://globalmonitor.einfomax.co.kr/ds_mobile_new.html#/USA/6/01`
 * 를 직접 확인해 발견(2026-09) — 연합인포맥스(Yonhap Infomax)가 운영하는
 * 증권사 리서치 통합 열람 서비스로, 키움·신한·유진·한화·대신·유안타·DB증권 등
 * 다수 증권사의 "미국주식" 분류 리포트를 한곳에 모아준다(한경 컨센서스가
 * 국내주식을 모아주는 것과 같은 성격, 다른 3자 편집 서비스). 페이지 자체는
 * AngularJS 1.4.9 레거시 SPA라 내부 JS 번들(module_constants_base_bundle.js)에서
 * 카테고리 코드(lscCd/sscCd)를, module_controller_m_bundle.js 에서 실제 호출
 * 파라미터(cmd:"rl_011" 등)를 역추적해 확인. 로그인 없이 POST 하나로 목록을
 * 받고, PDF도 로그인 없이 바로 열림(`rreport.einfomax.co.kr/report/{secureId}.pdf`,
 * 확인됨).
 *
 * ⚠️ globalmonitor.einfomax.co.kr 은 robots.txt 자체가 없음(404) — 가장 깨끗한
 *    케이스. 오너가 URL을 직접 제시하며 사용을 지시해 예외 승인(CLAUDE.md 참조).
 *
 * 제목이 "[종목명 (거래소:티커)] 제목" 형식(예: "[오라클 (NYS:ORCL)] 내 돈
 * 말고, 고객 돈으로")이라 티커를 바로 뽑는다 — 이름 검색 불필요. summary
 * 필드에 이미 정리된 한국어 요약 문단이 있어(다른 소스 대비 품질 좋음) 그대로
 * 저장.
 *
 * 산업분석/투자전략(2026-09 추가, 오너 지시 — "한국과 미국 모두 동일하게
 * 수집 기반 구축", "해외는 GM에서 받아오는 회사는 제외"): 위 종목 티커
 * 형식이 아닌 항목(채권/경제/시황 등, 예: "DB Morning Express", "미국 주식
 * 데일리 뉴스", "[AI Economist] ...", "[미국은 지금] ...")을 예전엔 통째로
 * 버렸는데, 실측 결과(2026-09) 300건 중 175건이 이런 산업분석/투자전략
 * 콘텐츠였다 — 이미 이 한 게시판에 키움·한화·유안타·DB·대신·LS·SK·iM·
 * 상상인·하나증권 등 다수 증권사가 다 모여 있어(auth 필드), 이걸 그대로
 * category:"산업"으로 추가 수집하면 그 증권사들을 하나하나 새로 붙일
 * 필요가 없다(오너 지시의 "GM에서 받아오는 회사는 제외" 조건이 바로 이
 * 의미 — 각 증권사 자체 산업분석 게시판을 따로 안 붙여도 됨). 제목이
 * "[라벨] 헤드라인" 형식이면 대괄호를 라벨로, 아니면 제목 전체를 헤드라인
 * 삼아 라벨은 "산업"으로 둔다. 신한투자증권은 기존처럼 계속 제외(자체
 * 해외 게시판이 이미 산업분석까지 다룸, EXCLUDED_SOURCES 참고).
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-globalmonitor-research.mjs
 *   node scripts/collect-globalmonitor-research.mjs --days=14 --pages=5 --dry-run
 */

import { readFileSync } from "node:fs";
import { enrichUsResearch } from "./lib/us-research-extract.mjs";
import { isEtfOrEtpContent } from "./lib/exclude-filters.mjs";

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
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://5-topaz-five.vercel.app/api/cron/shinhan-research"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim(); // 로컬 수동 실행 시 CRON_SECRET 없어도 인증 가능(라우트가 x-app-token도 허용)
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LIST_URL = "https://globalmonitor.einfomax.co.kr/bizrpt/reportlist";
const PAGE_SIZE = 50;
// module_constants_base_bundle.js 의 bizrptCodelist.usa_all 값(역추적 확인).
const USA_ALL = { lscCd: 700, sscCd: "524910,521090,523050,523070" };

// "[종목명 (거래소:티커)] 제목" — 거래소는 NYS/NAS 등, 표시엔 안 쓰고 티커만 사용.
const TITLE_RE = /^\[(.+?)\s*\(([A-Z]{2,5}):([A-Z.]+)\)\]\s*(.*)$/;

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const EXCERPT_LEN = 300;
function excerpt(text) {
  const flat = String(text ?? "").replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ").trim();
  return flat.length > EXCERPT_LEN ? `${flat.slice(0, EXCERPT_LEN)}…` : flat;
}

async function fetchPage(page, startDate) {
  const res = await fetch(LIST_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json;charset=UTF-8", "User-Agent": UA },
    body: JSON.stringify({
      targetPeriodCheck: false,
      page,
      pagePerItem: PAGE_SIZE,
      sortType: "date",
      lscCd: USA_ALL.lscCd,
      targetPeriodDate: null,
      sscCd: USA_ALL.sscCd,
      authSscCd: 0,
      cmd: "rl_011",
      startDate,
      searchItem: "",
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  // 날짜 필터(startDate)에 걸리는 항목이 요청한 페이지보다 적으면 서버가
  // res:false + reportlist:[] 로 응답한다(실측 2026-09: nav.totalPage 는 19인데
  // 5페이지가 빈 응답). 목록 끝으로 보고 조용히 멈춘다 — 여기서 throw 하면
  // 앞 페이지에서 이미 모은 것까지 통째로 버려진다. 단 1페이지부터 이러면
  // 진짜 실패이므로 그대로 던진다.
  if (!json.res) {
    if (page > 1) return null;
    throw new Error(`API 응답 실패: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return json.reportlist ?? [];
}

// "[라벨] 나머지" 에서 대괄호 머리말을 라벨로 뽑는다. 대괄호가 없거나 뒤에
// 남는 게 없으면(예: 라벨만 있고 본문이 없는 경우) 라벨을 "산업"으로 두고
// 원래 텍스트를 그대로 headline 으로 쓴다.
function bracketLabelAndRest(title) {
  const m = title.match(/^\[([^\]]*)\]\s*(.*)$/);
  if (!m) return { label: "산업", rest: title.trim() };
  const rest = m[2].trim();
  return rest ? { label: m[1].trim(), rest } : { label: "산업", rest: m[1].trim() };
}

function parseItems(rows) {
  const items = [];
  for (const r of rows) {
    const dateM = String(r.writeDate ?? "").match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
    if (!dateM) continue;
    const date = `${dateM[1]}-${dateM[2]}-${dateM[3]}`;
    // ETF/ETP 리포트 제외(오너 지시 2026-09-24, 공용 필터 — 여러 증권사가
    // 모이는 소스라 특히 잘 섞여 들어온다).
    if (isEtfOrEtpContent(r.title)) continue;
    const tm = String(r.title ?? "").match(TITLE_RE);
    if (tm) {
      const [, stockName, , ticker, headline] = tm;
      items.push({
        id: r.rptId,
        date,
        title: headline.trim() || stockName.trim(),
        stockName: stockName.trim(),
        symbolHint: ticker,
        analyst: r.writer ?? "",
        source: r.auth ?? "",
        // 응답에 투자의견 필드가 있다(빈 값인 행도 많음) — 있으면 그대로 쓰고,
        // 없으면 뒤의 enrichUsResearch 가 본문·PDF 에서 찾는다.
        opinion: String(r.rptopninvest ?? "").trim(),
        targetPrice: null,
        summary: excerpt(r.summary),
        pdfUrl: r.secureId ? `https://rreport.einfomax.co.kr/report/${r.secureId}.pdf` : null,
        category: "기업",
      });
      continue;
    }
    // 종목코드 없는 채권/경제/시황/전략 리포트 — 산업분석/투자전략으로 수집.
    const { label, rest } = bracketLabelAndRest(String(r.title ?? ""));
    items.push({
      id: r.rptId,
      date,
      title: rest,
      stockName: label,
      symbolHint: null,
      analyst: r.writer ?? "",
      source: r.auth ?? "",
      opinion: "",
      targetPrice: null,
      summary: excerpt(r.summary),
      pdfUrl: r.secureId ? `https://rreport.einfomax.co.kr/report/${r.secureId}.pdf` : null,
      category: "산업",
    });
  }
  return items;
}

console.log(`▶ GlobalMonitor 미국주식 리포트 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지`);
// 항목 날짜가 'YYYY-MM-DD'(=UTC 자정)라 컷오프도 자정으로 맞춘다.
// Date.now() 기준 그대로 두면 '정확히 DAYS일 전' 리포트가 시:분 차이로
// 매번 잘려나간다(실측 2026-09: 미래에셋 최신 리포트가 3시간 차이로 탈락).
const cutoff = new Date(new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10));
const startDate = ymd(new Date(Date.now() - DAYS * 86_400_000));
const collected = [];
let stop = false;
for (let page = 1; page <= MAX_PAGES && !stop; page++) {
  const rows = await fetchPage(page, startDate);
  if (rows === null || rows.length === 0) break;
  const items = parseItems(rows);
  for (const it of items) {
    if (new Date(it.date) < cutoff) {
      stop = true;
      break;
    }
    collected.push(it);
  }
  await sleep(400);
}

if (collected.length === 0) {
  console.error("✗ 파싱 결과 0건. 페이지 구조가 바뀌었을 수 있음.");
  process.exit(1);
}
console.log(`✔ 파싱 완료: ${collected.length}건`);
console.log(
  "  최근 5건:",
  collected.slice(0, 5).map((i) => `${i.date} [${i.source}] ${i.stockName}(${i.symbolHint}) — ${i.title}`),
);
// 산업분석/투자전략은 특정 종목 얘기가 아니므로 목표주가·투자의견 개념이
// 없음 — PDF에 우연히 등장하는 숫자를 잘못 채우지 않게 기업(종목) 항목만 보강.
await enrichUsResearch(collected.filter((it) => it.category === "기업"));

if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

// 자체 수집기가 있는 증권사는 여기서 뺀다 — 같은 문서가 GM 경유와 자체
// 수집기 양쪽에 중복 저장되는 걸 막는다(오너 지시 2026-09-24 — "글로벌
// 모니터에서 수집건 중 개별 증권사에서 수집된 동일한 문서는 제외해야한다").
//  - 신한투자증권: 자체 해외 게시판(collect-shinhan-overseas-research.mjs)이
//    같은 14일 기준 8건 대비 34건, 미국 외에 일본·중국·유럽까지 커버(오너 지시, 2026-09).
//  - 키움증권: 자체 수집기(collect-kiwoom-research.mjs, 2026-09-24 추가)가
//    PDF까지 로그인 없이 받아 GM 경유(PDF 없음)보다 데이터가 낫다.
const EXCLUDED_SOURCES = new Set(["신한투자증권", "키움증권"]);

// 증권사(제공출처)별로 그룹핑해 나눠 전송 — 라우트가 body당 source 하나만 받음
// (한경 컨센서스 스크립트와 동일 패턴).
const bySource = new Map();
for (const it of collected) {
  const key = it.source || "GlobalMonitor";
  if (EXCLUDED_SOURCES.has(key)) continue;
  if (!bySource.has(key)) bySource.set(key, []);
  bySource.get(key).push({
    id: `GM:${it.id}`,
    date: it.date,
    title: it.title,
    stockName: it.stockName,
    symbol: it.symbolHint,
    analyst: it.analyst,
    opinion: it.opinion,
    targetPrice: it.targetPrice,
    summary: it.summary,
    pdfUrl: it.pdfUrl,
    views: null,
    category: it.category,
  });
}

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;

let totalUpserted = 0;
for (const [source, group] of bySource) {
  const up = await fetch(IMPORT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ items: group, source, market: "us" }),
  });
  const upBody = await up.text();
  if (!up.ok) {
    console.error(`✗ [${source}] 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 200)}`);
    continue;
  }
  console.log(`✔ [${source}] ${group.length}건 전송: ${upBody}`);
  totalUpserted += group.length;
}
console.log(`\n✔ 총 ${totalUpserted}건 전송 완료 (${bySource.size}개 증권사)`);
