/**
 * NH투자증권 "기업/산업분석" 리포트 — 로컬 수집기.
 *
 * www.nhsec.com 은 레거시 frameset 사이트(실제 콘텐츠는 /main.html 프레임 안)라
 * 화면 자체는 DOM 스크레이핑이 아니라, 프레임 내부 JS(`boardList()`)가 호출하는
 * 내부 TR(트랜잭션) API `/research/boardCommonTrAjax.action` (trName=H3211)를
 * 역추적해 직접 호출한다. 로그인 불필요, 응답은 **EUC-KR** 인코딩 JSON.
 * 커서 기반 페이지네이션(`isNext` + 마지막 행의 `rsh_ppr_no`/`rsh_ppr_dru_dt`/
 * `rsh_ppr_dru_tm`를 다음 요청에 그대로 실어 보냄) — 페이지 번호 방식이 아님.
 * `rmt_cnt`를 아무리 크게 줘도 서버가 최대 20건으로 잘라서 응답(실측 확인).
 *
 * 목록 응답에 종목코드(`rsh_ppr_iem_cd_pcl`, 콤마 구분— 산업 리포트는 여러
 * 종목을 한 번에 커버)와 PDF 직링크(`hpge_fle_url_cts`)가 이미 들어있어 다른
 * 증권사처럼 제목에서 코드를 정규식으로 뽑거나 이름 검색을 할 필요가 없다.
 * 종목명은 표시용으로만 이 프로젝트의 정적 상장사 목록(`corpcodes.json`,
 * DART_API_KEY 불필요)에서 코드로 역조회한다. 코드가 여러 개인 산업 리포트는
 * 코드별로 항목을 복제해서 보낸다(같은 리포트가 여러 종목 카드에 보일 수 있음 —
 * 한경 컨센서스와 동일한 트레이드오프, 기능상 문제 없음). 해외종목만 다루는
 * 리포트(코드 없음, 예: "[해외기업분석/Apple]")는 건너뜀.
 *
 * ⚠️ www.nhsec.com/robots.txt 는 `Disallow: /`(Googlebot 등 주요 크롤러만 예외)다.
 *    다른 예외들과 동일하게 "개인용·로컬 실행·저빈도" 조건으로 오너 승인
 *    (CLAUDE.md 참조, 오너가 "NH투자증권도 로그인없이 가능하다" 직접 확인).
 *    앱 배포본(Vercel)에는 이 수집 코드가 없다.
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-nh-research.mjs
 *   node scripts/collect-nh-research.mjs --days=14 --pages=10 --dry-run
 */

import { readFileSync } from "node:fs";

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
const MAX_PAGES = Number(ARGS.find((a) => a.startsWith("--pages="))?.split("=")[1]) || 10;

const IMPORT_URL = (
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://5-topaz-five.vercel.app/api/cron/shinhan-research"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim(); // 로컬 수동 실행 시 CRON_SECRET 없어도 인증 가능(라우트가 x-app-token도 허용)
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const AJAX_URL = "https://www.nhsec.com/research/boardCommonTrAjax.action";
const PAGE_SIZE = 20; // 서버가 이보다 많이 요청해도 20건으로 잘라 응답(실측 확인)

// 종목코드 → 한글 상장사명(표시용). corpcodes.json 은 이 저장소가 이미
// DART L1 수집에 쓰는 정적 상장사 목록(DART_API_KEY 불필요).
const corpcodes = JSON.parse(
  readFileSync(new URL("../src/lib/markets/kr/data/corpcodes.json", import.meta.url), "utf8"),
);
const nameByCode = new Map(corpcodes.map((c) => [c.s, c.n]));

function isoDate(yyyymmdd) {
  const m = String(yyyymmdd).match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

async function fetchPage(cursor) {
  const body = new URLSearchParams({
    trName: "H3211",
    output: "json",
    isNext: cursor ? "true" : "false",
    rsh_ppr_dit_cd: "01", // 기업/산업분석
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
      Referer: "https://www.nhsec.com/research/boardList.action?rsh_ppr_dit_cd=01",
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

console.log(`▶ NH투자증권 기업/산업분석 리포트 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지`);
const cutoff = new Date(Date.now() - DAYS * 86_400_000);
const collected = [];
let cursor = null;
let stop = false;

for (let page = 1; page <= MAX_PAGES && !stop; page++) {
  const json = await fetchPage(cursor);
  const rows = parseRows(json);
  if (rows.length === 0) break;

  for (const r of rows) {
    const date = isoDate(r.rsh_ppr_dru_dt);
    if (date && new Date(date) < cutoff) {
      stop = true;
      break;
    }
    const codes = String(r.rsh_ppr_iem_cd_pcl ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter((c) => /^\d{6}$/.test(c));
    if (!date || codes.length === 0) continue; // 코드 없음(해외종목만 다룸) — 건너뜀
    for (const code of codes) {
      collected.push({
        id: `${r.rsh_ppr_no}:${code}`,
        date,
        title: r.rsh_ppr_til_cts,
        stockName: nameByCode.get(code) ?? code,
        symbol: code,
        analyst: r.rsh_ppr_dru_emp_fnm ?? "",
        opinion: "",
        summary: "",
        pdfUrl: r.hpge_fle_url_cts || null,
        views: null,
      });
    }
  }

  const last = rows[rows.length - 1];
  cursor = { no: last.rsh_ppr_no, date: last.rsh_ppr_dru_dt, time: last.rsh_ppr_dru_tm };
  await sleep(400);
}

if (collected.length === 0) {
  console.error("✗ 파싱 결과 0건. API 구조가 바뀌었을 수 있음.");
  process.exit(1);
}
console.log(`✔ 파싱 완료: ${collected.length}건`);
console.log(
  "  최근 5건:",
  collected.slice(0, 5).map((i) => `${i.date} ${i.stockName}(${i.symbol}) — ${i.title}`),
);
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
  body: JSON.stringify({ items: collected, source: "NH투자증권" }),
});
const upBody = await up.text();
if (!up.ok) {
  console.error(`✗ 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
  process.exit(1);
}
console.log(`\n✔ 앱 전송 완료: ${upBody}`);
