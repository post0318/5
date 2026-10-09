/**
 * FISCO(株式会社フィスコ) 企業調査レポート 수집기 — 일본 종목 리서치(오너 지시 2026-10-10 "일본 현지 리서치까지").
 * 조사 근거(2026-10-10 원문 확인):
 *  - 목록: https://www.fisco.co.jp/service/report/ — 로그인 없이 서버렌더 HTML 한 장에 전 기간 목록(2026-10 기준 약 3,700건)이
 *    `<li>YYYY年MM月DD日 公開 <a href="…/uploads/FISCO/{파일}.pdf">『회사명<코드>』</a></li>` 로 들어 있다. 요청은 회차당 1번.
 *  - robots.txt: `Disallow: /wordpress/wp-admin/` 뿐(목록·PDF 경로 허용).
 *  - 사이트 정책(サイトポリシー, 2026-08-10 제정) 2조: 문장·리포트 등 콘텐츠의 저작권은 FISCO 또는 제공자에게 있고, 허락 없는
 *    복제·공중송신(업로드 포함)·전재·판매·개작 금지. 3조: 링크는 원칙 자유. 크롤링·자동 수집을 금지하는 조항은 없다.
 *    → **목록 메타(날짜·회사명·코드)와 원문 PDF 링크만** 저장한다. PDF 본문·요약 발췌는 저장하지 않는다(복제·전재에 해당할 수 있음).
 *  - 성격: 발행 회사가 비용을 대는 스폰서드 리서치(企業調査レポート). 투자의견·목표주가가 없다 → 공용 추출기를 돌리지 않는다.
 *  - 영어판(파일명 _e.pdf·"(英語版)")은 같은 리포트의 번역이라 일본어판만 받는다.
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-fisco-research.mjs                # 최근 3일
 *   node scripts/collect-fisco-research.mjs --days=30 --dry-run
 */

import { readFileSync } from "node:fs";
import { appUrl } from "./lib/app-url.mjs";
import { appSendFailed, exitNoItems } from "./lib/collector-status.mjs";
import { isCommonExcludedContent } from "./lib/exclude-filters.mjs";

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

const IMPORT_URL = (ENV.SHINHAN_RESEARCH_IMPORT_URL || `${appUrl(ENV)}/api/cron/total-research`).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim();
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const LIST_URL = "https://www.fisco.co.jp/service/report/";
const SOURCE = "FISCO";

// "2026年10月09日 公開 <a href="….pdf" …>『ポールトゥウィンホールディングス<3657>』"
const ROW_RE = /<li>\s*(\d{4})年(\d{2})月(\d{2})日\s*公開\s*<a href="(https:\/\/www\.fisco\.co\.jp\/[^"]+\.pdf)"[^>]*>『([^』<]+?)<(\d{3}[0-9A-Z])>』/g;

console.log(`▶ FISCO 企業調査レポート 수집: 최근 ${DAYS}일`);
const res = await fetch(LIST_URL, { headers: { "User-Agent": UA } });
if (!res.ok) {
  console.error(`✗ 목록 HTTP ${res.status}`);
  process.exit(1);
}
const html = await res.text();
const cutoff = new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10);
const collected = [];
let parsed = 0;
let english = 0;
for (const m of html.matchAll(ROW_RE)) {
  parsed++;
  const [, y, mo, d, pdfUrl, rawName, code] = m;
  const date = `${y}-${mo}-${d}`;
  if (date < cutoff) continue;
  if (/_e\.pdf$/i.test(pdfUrl) || /英語版/.test(rawName)) {
    english++;
    continue;
  }
  // 공통 제외(ETF·ESG·주간물 등) — 회사명뿐이라 거의 걸리지 않지만 모든 수집기 공통 규칙을 따른다
  if (isCommonExcludedContent(rawName, "기업", "jp")) continue;
  collected.push({
    id: pdfUrl.split("/").pop(),
    date,
    title: "기업조사 리포트(企業調査レポート)",
    stockName: rawName.trim(),
    symbol: code,
    analyst: "",
    opinion: "",
    targetPrice: null,
    summary: "",
    pdfUrl,
    views: null,
    category: "기업",
    board: "FISCO > 企業調査レポート",
  });
}
// 목록 구조가 바뀌면 0건으로 조용히 끝나지 않게 — 전체 판독 건수가 0이면 실패
if (parsed === 0) {
  console.error("✗ 목록에서 리포트 행을 하나도 못 읽음(구조 변경?)");
  process.exit(1);
}
console.log(`  목록 판독 ${parsed}건 · 기간 내 ${collected.length}건(영어판 ${english}건 제외)`);
if (collected.length === 0) exitNoItems({ market: "jp", label: "fisco" });
for (const it of collected) console.log(`  ${it.date} ${it.symbol} ${it.stockName} — ${it.pdfUrl}`);

if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;
const up = await fetch(IMPORT_URL, { method: "POST", headers, body: JSON.stringify({ items: collected, source: SOURCE, market: "jp" }) });
const upBody = await up.text();
if (appSendFailed(up, upBody)) {
  console.error(`✗ [${SOURCE}/jp] 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
  process.exit(1);
}
console.log(`✔ [${SOURCE}/jp] 앱 전송 완료 (${collected.length}건): ${upBody}`);
