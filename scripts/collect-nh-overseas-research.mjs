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
import { enrichUsResearch } from "./lib/us-research-extract.mjs";

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

function isoDate(yyyymmdd) {
  const m = String(yyyymmdd).match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// "[해외기업분석/Apple] 아이폰18, 균형 잡힌 전략" 또는
// "[해외기업분석 Spot/Citigroup] 10년 만의 최대 분기 실적" — 회사명과 본문
// 제목 분리. "Spot" 처럼 분류 뒤에 태그가 더 붙는 경우도 있어 유연하게 받는다.
const TITLE_RE = /^\[해외기업분석(?:\s+\S+)?\s*\/\s*([^\]]+)\]\s*(.+)$/;

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
      rawRows.push(r);
    }
    const last = rows[rows.length - 1];
    cursor = { no: last.rsh_ppr_no, date: last.rsh_ppr_dru_dt, time: last.rsh_ppr_dru_tm };
    await sleep(400);
  }
}

console.log(`  목록 ${rawRows.length}건 중 해외기업분석 매핑 시도...`);
const collected = [];
for (const r of rawRows) {
  const tm = String(r.rsh_ppr_til_cts ?? "").match(TITLE_RE);
  if (!tm) continue; // 국내 리포트·업종 리포트 등 — 건너뜀
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
  });
}

if (collected.length === 0) {
  console.error(`✗ 종목 매핑 결과 0건(원본 ${rawRows.length}건). 게시판 구조가 바뀌었을 수 있음.`);
  process.exit(1);
}
console.log(`✔ 파싱 완료: ${collected.length}건 (원본 ${rawRows.length}건 중 미국 종목만)`);
console.log(
  "  최근 3건:",
  collected.slice(0, 3).map((i) => `${i.date} ${i.stockName}(${i.symbol}) — ${i.title}`),
);

await enrichUsResearch(collected);

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
