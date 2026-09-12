/**
 * KB증권 "산업/기업" 리포트 — 로컬 수집기.
 *
 * www.kbsec.com 리서치보고서 메뉴("산업/기업" 탭, tab=5)는 화면이 호출하는
 * 내부 TR API `/go.able?linkcd=s040203010001` (POST, `document.forms[0]`
 * 직렬화 — `tab=5`, `searchMonth=3` 등)를 역추적해 직접 호출한다. 로그인
 * 불필요, 응답은 UTF-8 JSON(`{list:[...]}`) — 한 번의 요청으로 최근 3개월치
 * (`searchMonth=3`)를 통째로 받아오므로 페이지네이션이 불필요하다.
 *
 * 응답에 종목명+코드가 합쳐진 제목("종목명 (코드)")과 부제(실제 헤드라인),
 * 투자의견(`recomm`, 영문 Buy/Hold/Sell 등), PDF 직링크(`urlLink`)가 모두
 * 들어있다. **PDF는 실측 결과 로그인 없이 그대로 다운로드된다**(오너가
 * "kb는 pdf는 로그인해야하나 본문은 가능하다"고 전달했던 것과 달리, 최소
 * "산업/기업" 게시판은 로그인 불필요로 확인됨 — 필요시 재확인). 종목코드 없이
 * 업종명만 있는 리포트(대표 종목코드가 임의로 붙어있는 경우 포함, 예:
 * "반도체"·"유틸리티" 제목에 삼성전자/한국전력 코드가 딸려오는 경우)는
 * 제목이 "종목명 (코드)" 패턴이 아니므로 걸러진다.
 *
 * ⚠️ www.kbsec.com, rdata.kbsec.com 모두 robots.txt 자체가 없음(404/302) —
 *    지금까지 중 가장 깨끗한 케이스. 그래도 다른 예외들과 동일하게
 *    "개인용·로컬 실행·저빈도" 조건으로 오너 승인(CLAUDE.md 참조, 오너가
 *    "kb는 pdf는 로그인해야하나 본문은 가능하다" 직접 확인).
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-kb-research.mjs
 *   node scripts/collect-kb-research.mjs --days=14 --dry-run
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
const DAYS = Number(ARGS.find((a) => a.startsWith("--days="))?.split("=")[1]) || 30;

const IMPORT_URL = (
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://5-topaz-five.vercel.app/api/cron/shinhan-research"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

const AJAX_URL = "https://www.kbsec.com/go.able?linkcd=s040203010001";
const TITLE_RE = /^(.+?)\s*\((\d{6})\)$/;

async function fetchList() {
  const body = new URLSearchParams({
    pCatfolderid: "",
    templateid: "",
    lowTempId: "",
    searchMonth: "3", // 최근 3개월(사이트가 지원하는 값: 1/3/6/36) — 한 번의 요청으로 충분
    searchFlag: "",
    sDocumentid: "",
    sUrlLink: "",
    wInfo: "",
    tab: "5", // 산업/기업
  });
  const res = await fetch(AJAX_URL, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return json.list ?? [];
}

console.log(`▶ KB증권 산업/기업 리포트 수집: 최근 ${DAYS}일`);
const cutoff = new Date(Date.now() - DAYS * 86_400_000);
const rows = await fetchList();

const collected = [];
for (const r of rows) {
  const tm = String(r.docTitle ?? "").trim().match(TITLE_RE);
  if (!tm) continue; // 업종 리포트(종목코드 없음, 또는 대표코드만 딸려있음) — 건너뜀
  const date = r.publicDate;
  if (!date || new Date(date) < cutoff) continue;
  collected.push({
    id: r.documentid,
    date,
    title: (r.docTitleSub || tm[1]).trim(),
    stockName: tm[1].trim(),
    symbol: tm[2],
    analyst: r.analystNm ?? "",
    opinion: r.recomm ?? "",
    summary: "",
    pdfUrl: r.urlLink || null,
    views: null,
  });
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
if (CRON_SECRET) headers.Authorization = `Bearer ${CRON_SECRET}`;
const up = await fetch(IMPORT_URL, {
  method: "POST",
  headers,
  body: JSON.stringify({ items: collected, source: "KB증권" }),
});
const upBody = await up.text();
if (!up.ok) {
  console.error(`✗ 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
  process.exit(1);
}
console.log(`\n✔ 앱 전송 완료: ${upBody}`);
