/**
 * NH투자증권 "해외기업분석" 리포트 수집기 (미국 종목).
 *
 * 같은 TR(H3211)을 두 게시판 코드(rsh_ppr_dit_cd)로 스캔한다:
 *   - "03" = 메뉴상 "해외주식" 전용 게시판(오너 지적으로 재확인, 2026-09).
 *     실측: 90일치 95건 중 60건이 아래 브라켓 패턴에 매칭 — 진짜 주력 소스.
 *   - "01" = 국내 수집기(collect-nh-research.mjs)와 같은 "기업/산업분석"
 *     게시판. 해외 리포트가 드물게 섞여 나오기도 해(90일 3건) 놓치지 않게
 *     계속 같이 스캔한다.
 * 두 게시판 모두 종목코드 필드(rsh_ppr_iem_cd_pcl)가 해외 리포트에서는
 * 항상 비어 있어, 제목이 "[해외기업분석/Apple] 아이폰18, 균형 잡힌 전략"
 * 처럼 대괄호 안에 "해외기업분석/회사명"이 들어있는 경우로 골라낸다
 * (다른 no-code 항목은 국내 비상장사·업종·전략 리포트라 이 패턴에 안 걸림).
 *
 * 회사명(영문/한글 혼용, 예: "Apple")을 네이버 해외종목 자동완성으로 티커
 * 해석한다(DS투자증권 수집기와 동일 방식).
 *
 * 목표주가·투자의견은 PDF 본문에 "목표주가(컨센서스): 331.5달러"처럼
 * 실려 있어 공용 추출기(us-research-extract.mjs)의 컨센서스 패턴이 그대로
 * 잡는다(실측 확인 — 별도 전용 패턴 불필요).
 *
 * ⚠️ www.nhsec.com/robots.txt 는 `Disallow: /` — 국내 수집기와 동일 조건
 *    (개인용·로컬 실행·저빈도)으로 예외 승인(CLAUDE.md 참조).
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-nh-overseas-research.mjs
 *   node scripts/collect-nh-overseas-research.mjs --days=90 --pages=20 --dry-run
 */

import { readFileSync } from "node:fs";
import { enrichUsResearch, readPdfText } from "./lib/us-research-extract.mjs";

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
const MAX_PAGES = Number(arg("pages")) || 20;

const AJAX_URL = "https://www.nhsec.com/research/boardCommonTrAjax.action";
const PAGE_SIZE = 20; // 서버가 이보다 많이 요청해도 20건으로 잘라 응답(실측 확인)
const IMPORT_URL = (
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://5-topaz-five.vercel.app/api/cron/shinhan-research"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim();
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 목록 응답에 본문 발췌가 아예 없어(summary 는 항상 "") 국내 수집기
// (collect-nh-research.mjs)처럼 PDF 본문에서 발췌를 뽑는다 — 그동안 이
// 스크립트에만 이 단계가 빠져 있었음(오너 지적, 2026-09 — 특정 리포트의
// 발췌 공란을 확인해 발견). 헤더/표지 블록을 건너뛰는 휴리스틱은 국내
// 수집기와 동일.
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

function isoDate(yyyymmdd) {
  const m = String(yyyymmdd).match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// "[해외기업분석/Apple] 아이폰18, 균형 잡힌 전략" 또는
// "[해외기업분석 Spot/Citigroup] 10년 만의 최대 분기 실적" — 회사명과 본문
// 제목 분리. "Spot" 처럼 분류 뒤에 태그가 더 붙는 경우도 있어 유연하게 받는다.
const TITLE_RE = /^\[해외기업분석(?:\s+\S+)?\s*\/\s*([^\]]+)\]\s*(.+)$/;

// 산업분석/투자전략(2026-09 추가, 오너 지시 — "한국과 미국 모두 동일하게
// 수집 기반 구축"): "[전략 인사이드/미국] 미국 중간선거, 표적이 된 데이터센터"
// 처럼 종목 없이 국가·주제별 전략을 다루는 시리즈, "[글로벌 사이버보안 산업]
// 사이버보안, 구조적 성장 국면"처럼 슬래시 없이 업종명만 있는 리포트가 이
// 게시판에 섞여 있다(실측, dit_cd=03). 둘 다 종목코드 필드가 비어 있어
// TITLE_RE 에 안 걸리고 지금까지 버려졌다. "전략 인사이드"는 국가별로 도는
// 시리즈라(중국·일본 등도 나옴) 미국과 무관한 회차는 건너뛰고, 그 외
// 슬래시 없는 업종/주제 리포트는 이 수집기가 이미 미국 종목만 다루는
// 맥락이라 그대로 미국 산업분석으로 편입한다.
const STRATEGY_INSIDE_RE = /^\[전략\s*인사이드\/([^\]]+)\]\s*(.+)$/;
const GENERIC_BRACKET_RE = /^\[([^\]]+)\]\s*(.+)$/;
// "전략 인사이드" 태그가 명시적으로 다른 나라를 가리키면 제외(이 수집기는
// 미국 전용) — 프로젝트가 다루는 나머지 시장(한국·일본)은 각자의 수집기가 있음.
const NON_US_COUNTRY_RE = /중국|일본|유럽|홍콩|대만|동남아|한국|인도/;

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

/** 한글/영문 회사명 → 미국 티커(네이버 해외종목 자동완성). 실패하면 null. */
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
      hit =
        items.find((i) => i.nationCode === "USA" && i.name?.trim() === key) ??
        items.find((i) => i.nationCode === "USA") ??
        null;
      if (hit) hit = { symbol: String(hit.code).toUpperCase(), stockName: hit.name ?? key };
    }
  } catch {
    /* 무시 */
  }
  usCache.set(key, hit);
  await sleep(300);
  return hit;
}

console.log(`▶ NH투자증권 해외기업분석 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지 (게시판 03+01)`);
// 항목 날짜가 'YYYY-MM-DD'(=UTC 자정)라 컷오프도 자정으로 맞춘다.
const cutoff = new Date(new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10));
const rawRows = [];
// "03"(해외주식 전용 게시판, 주력 소스) + "01"(기업/산업분석, 드물게 해외 리포트 섞임) 둘 다 스캔.
for (const ditCd of ["03", "01"]) {
  let cursor = null;
  let stop = false;
  for (let page = 1; page <= MAX_PAGES && !stop; page++) {
    const json = await fetchPage(ditCd, cursor);
    const rows = parseRows(json);
    if (rows.length === 0) break;
    for (const r of rows) {
      const date = isoDate(r.rsh_ppr_dru_dt);
      if (date && new Date(date) < cutoff) {
        stop = true;
        break;
      }
      rawRows.push({ ...r, __ditCd: ditCd });
    }
    const last = rows[rows.length - 1];
    cursor = { no: last.rsh_ppr_no, date: last.rsh_ppr_dru_dt, time: last.rsh_ppr_dru_tm };
    await sleep(400);
  }
}

console.log(`  목록 ${rawRows.length}건 중 해외기업분석 매핑 시도...`);
const collected = [];
for (const r of rawRows) {
  const rawTitle = String(r.rsh_ppr_til_cts ?? "");
  const tm = rawTitle.match(TITLE_RE);
  if (tm) {
    const hit = await resolveUsTicker(tm[1]);
    if (!hit) continue; // 티커 해석 실패(미국 외 시장 등)
    collected.push({
      id: r.rsh_ppr_no,
      date: isoDate(r.rsh_ppr_dru_dt),
      title: tm[2].trim(),
      stockName: hit.stockName,
      symbol: hit.symbol,
      analyst: r.rsh_ppr_dru_emp_fnm ?? "",
      opinion: "",
      targetPrice: null,
      summary: "",
      pdfUrl: r.hpge_fle_url_cts || null,
      views: null,
      category: "기업",
    });
    continue;
  }

  // 산업/전략 폴백은 "해외주식" 전용 게시판(03)에서만 — 국내 게시판(01)은
  // 평범한 국내 종목 리포트도 "[종목명] 헤드라인" 대괄호 형식을 쓰기 때문에
  // (예: "[대우건설] 팀코리아 대표 시공 파트너") 여기서 걸러내지 않으면
  // 국내 종목이 "미국 산업분석"으로 잘못 편입된다(실측으로 확인한 버그).
  if (r.__ditCd !== "03") continue;

  const sm = rawTitle.match(STRATEGY_INSIDE_RE);
  if (sm) {
    if (NON_US_COUNTRY_RE.test(sm[1])) continue; // 미국 외 국가 회차 — 건너뜀
    collected.push({
      id: r.rsh_ppr_no,
      date: isoDate(r.rsh_ppr_dru_dt),
      title: sm[2].trim(),
      stockName: "투자전략",
      symbol: null,
      analyst: r.rsh_ppr_dru_emp_fnm ?? "",
      opinion: "",
      targetPrice: null,
      summary: "",
      pdfUrl: r.hpge_fle_url_cts || null,
      views: null,
      category: "산업",
    });
    continue;
  }

  const gm = rawTitle.match(GENERIC_BRACKET_RE);
  if (gm && !NON_US_COUNTRY_RE.test(gm[1])) {
    collected.push({
      id: r.rsh_ppr_no,
      date: isoDate(r.rsh_ppr_dru_dt),
      title: gm[2].trim(),
      stockName: gm[1].trim(),
      symbol: null,
      analyst: r.rsh_ppr_dru_emp_fnm ?? "",
      opinion: "",
      targetPrice: null,
      summary: "",
      pdfUrl: r.hpge_fle_url_cts || null,
      views: null,
      category: "산업",
    });
  }
  // 대괄호 자체가 없는 국내·업종·비관련 리포트는 계속 건너뜀.
}

if (collected.length === 0) {
  console.error(`✗ 종목 매핑 결과 0건(원본 ${rawRows.length}건). 게시판 구조가 바뀌었을 수 있음.`);
  process.exit(1);
}
const companyCount = collected.filter((i) => i.category === "기업").length;
console.log(
  `✔ 파싱 완료: ${collected.length}건 (원본 ${rawRows.length}건 중 기업 ${companyCount}건 + 산업/전략 ${collected.length - companyCount}건)`,
);
console.log(
  "  최근 3건:",
  collected.slice(0, 3).map((i) => `${i.date} ${i.stockName}(${i.symbol}) — ${i.title}`),
);

// 산업/전략 노트는 특정 종목 얘기가 아니라 목표주가·투자의견 개념이 없음 —
// PDF에 우연히 등장하는 숫자를 잘못 채우지 않게 기업(종목) 항목만 보강한다.
await enrichUsResearch(collected.filter((it) => it.category === "기업"));

// 본문 발췌(summary)는 기업·산업 구분 없이 전부 채운다(목표주가·투자의견과
// 달리 오분류 위험이 없음). 같은 PDF를 여러 번 안 받게 캐시.
console.log(`▶ PDF 본문 발췌 중...`);
const excerptCache = new Map();
let excerptFailCount = 0;
for (const it of collected) {
  if (it.summary || !it.pdfUrl) continue;
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

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;
const up = await fetch(IMPORT_URL, {
  method: "POST",
  headers,
  body: JSON.stringify({ items: collected, source: "NH투자증권", market: "us" }),
});
const upBody = await up.text();
if (!up.ok) {
  console.error(`✗ 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
  process.exit(1);
}
console.log(`\n✔ 앱 전송 완료: ${upBody}`);
