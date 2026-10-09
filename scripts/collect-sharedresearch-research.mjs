/**
 * Shared Research(株式会社シェアードリサーチ) 레포트 갱신 수집기 — 일본 종목 리서치(오너 지시 2026-10-10 "Shared Research 예외로 처리").
 * ⚠️ 약관 위험을 오너가 알고 예외로 진행한 소스다(CLAUDE.md 크롤링 예외 7건):
 *  - SR レポート利用規約(https://sharedresearch.jp/ja/terms/sr-report) 제10조 — 당사 시스템의 리버스엔지니어링·해석 행위 금지,
 *    동종·유사 서비스 금지. 그래서 **내부 API(/api/…)는 쓰지 않는다** — 브라우저로 누구나 여는 공개 페이지 HTML 만 읽는다.
 *  - robots.txt — 일반 UA 는 전부 허용, ClaudeBot·GPTBot·ChatGPT 등 AI 크롤러만 차단. 이 수집기는 일반 브라우저 UA·하루 1요청.
 * 근거(2026-10-10 실측):
 *  - 공개 목록 https://sharedresearch.jp/ja/companies 의 HTML 에 커버 종목 전체(ACTIVE 400사)가 `window.state = {"companies":[…]}` 로
 *    서버렌더돼 있다. 종목마다 tick(종목코드)·회사명·최근 레포트 공개 시각(maxPublishedAt.ja)이 있다 — 이걸로 "그날 갱신된 종목"을 안다.
 *  - 종목 페이지 https://sharedresearch.jp/ja/companies/{코드} 는 로그인 없이 레포트 본문이 그대로 보인다(서버렌더). 링크는 이 페이지로 둔다.
 *    PDF 다운로드는 화면 버튼이 내부 API 를 불러서 받는 구조라 쓰지 않는다.
 *  - 저장 범위는 FISCO 와 같다: 날짜·회사명·종목코드·공개 페이지 링크만. 본문·요약은 저장하지 않는다.
 *  - 레포트 갱신 유형(전체 갱신·FLASH·NEWS_UPDATE·인터뷰 후 갱신)은 종목 페이지(약 4MB)를 열어야 나온다 — 하루 10~15사라도 요청이
 *    커서 읽지 않는다. 제목은 "레포트 갱신" 고정.
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-sharedresearch-research.mjs                # 최근 3일
 *   node scripts/collect-sharedresearch-research.mjs --days=30 --dry-run
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
const LIST_URL = "https://sharedresearch.jp/ja/companies";
const SOURCE = "Shared Research";

/** 공개 페이지 HTML 의 `window.state = {…}` 를 괄호 짝으로 잘라 읽는다(문자열 속 괄호는 건너뜀) */
function readPageState(html) {
  const at = html.indexOf("window.state");
  if (at < 0) return null;
  const start = html.indexOf("{", at);
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return JSON.parse(html.slice(start, i + 1));
  }
  return null;
}

console.log(`▶ Shared Research 레포트 갱신 수집: 최근 ${DAYS}일`);
const res = await fetch(LIST_URL, { headers: { "User-Agent": UA, "Accept-Language": "ja" } });
if (!res.ok) {
  console.error(`✗ 목록 HTTP ${res.status}`);
  process.exit(1);
}
const state = readPageState(await res.text());
const companies = state?.companies;
// 목록 구조가 바뀌면 0건으로 조용히 끝나지 않게 — 종목을 하나도 못 읽으면 실패
if (!Array.isArray(companies) || companies.length === 0) {
  console.error("✗ 목록 페이지에서 종목 목록(window.state.companies)을 못 읽음(구조 변경?)");
  process.exit(1);
}
const cutoff = new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10);
const collected = [];
for (const c of companies) {
  const code = String(c.tick ?? "").trim().toUpperCase();
  const published = c.maxPublishedAt?.ja;
  if (!/^\d{3}[0-9A-Z]$/.test(code) || !published || c.status !== "ACTIVE") continue;
  const date = String(published).slice(0, 10);
  if (date < cutoff) continue;
  const name = (c.shortName?.ja || c.name?.ja || code).replace(/株式会社/g, "").trim();
  if (isCommonExcludedContent(name, "기업", "jp")) continue;
  collected.push({
    // 같은 종목이 다른 날 갱신되면 새 문서 — 공개 시각까지 넣어 하루 두 번 갱신도 구분
    id: `${code}:${published}`,
    date,
    title: "레포트 갱신(Shared Research)",
    stockName: name,
    symbol: code,
    analyst: "",
    opinion: "",
    targetPrice: null,
    summary: "",
    pdfUrl: `https://sharedresearch.jp/ja/companies/${code}`,
    views: null,
    category: "기업",
    board: "Shared Research > 커버 종목(공개 목록)",
  });
}
console.log(`  목록 ${companies.length}사 · 기간 내 갱신 ${collected.length}건`);
if (collected.length === 0) exitNoItems({ market: "jp", label: "sharedresearch" });
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
