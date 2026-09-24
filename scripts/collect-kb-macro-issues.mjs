/**
 * KB증권 거시경제 > 이슈분석/환율분석 수집기 — `collect-kb-research.mjs`
 * (종목·산업분석, `kr_research`)와는 완전히 별개 대상·스키마·라우트
 * (`macro_issues`, `/api/cron/macro-issues`)라 키움의 `collect-kiwoom-
 * macro-issues.mjs`와 같은 패턴으로 별도 스크립트로 뺐다. 두 게시판을 다룬다:
 *
 * 1) **KB Bond·KB Fed Watch**(tab=3 "한국 투자 > 채권/크레딧", docTitle
 *    정확히 일치) — 오너 지시(2026-09-24 — "kb bond는 거시경제>이슈분석에
 *    해당된다. 나머지는 수집에서 제외한다" → 이후 "KB Fed Watch는
 *    이슈분석에 포함한다"로 정정) — 고정 topic:"이슈분석". 같은 게시판의
 *    "KB Credit Weekly"는 여전히 제외.
 * 2) **자산배분/매크로**(tab=2 전체 — 대체투자/자산배분/매크로/자산배분기타)
 *    — 오너 지시(2026-09-24 — "자산배분/매크로는 거시경제>이슈분석에
 *    해당한다. 다만, weekly, 주간 등은 수집대상이 아니다. 구분값이 환율이거나
 *    FX로 되어있다면 환율분석으로 분류한다"): 항목별로 제목/폴더 경로에
 *    "Weekly"/위클리/주간이 있으면 건너뛰고(예: "KB Crypto 트래커 |
 *    Weekly", "주간 주식시장 동향 및 전망"), 제목 또는 폴더 경로 말단이
 *    "FX"/"환율"이면(예: 폴더 "...매크로>환율", 제목 "FX 전략") topic을
 *    "환율분석"으로, 그 외는 "이슈분석"으로 분류한다.
 *
 * 같은 내부 TR(`s040203010001`)을 쓴다 — 응답의 `categoryid` 필드만으론
 * 게시판을 정확히 못 가른다(실측 — 같은 categoryid 안에 다른 시리즈가
 * 섞여 나옴, `collect-kb-research.mjs` 주석 참고). KB Bond는 docTitle
 * 정확히 일치로, 자산배분/매크로는 tab=2 전체를 훑되 위 규칙으로 필터링한다.
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-kb-macro-issues.mjs
 *   node scripts/collect-kb-macro-issues.mjs --days=30 --dry-run
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
const DAYS = Number(ARGS.find((a) => a.startsWith("--days="))?.split("=")[1]) || 7;

const IMPORT_URL = (ENV.MACRO_ISSUES_IMPORT_URL || "https://macroresearch.vercel.app/api/cron/macro-issues").trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim();
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

const AJAX_URL = "https://www.kbsec.com/go.able?linkcd=s040203010001";
// 오너 지시 — "weekly, 주간 등은 수집대상이 아니다". 프로젝트 공용
// isWeeklyRecurringContent()(Weekly/위클리만)보다 넓게 "주간"까지 포함한다 —
// 이 게시판(자산배분/매크로)에 한정된 규칙.
const WEEKLY_RE = /\bWeekly\b|위클리|주간/i;
const FX_RE = /\bFX\b|환율/i;

async function fetchList(tab) {
  const body = new URLSearchParams({
    pCatfolderid: "",
    templateid: "",
    lowTempId: "",
    searchMonth: "3",
    searchFlag: "",
    sDocumentid: "",
    sUrlLink: "",
    wInfo: "",
    tab,
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

console.log(`▶ KB증권 거시경제(이슈분석/환율분석) 수집: 최근 ${DAYS}일`);
const cutoff = new Date(new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10));

const collected = [];

// 1) KB Bond(tab=3) — 고정 이슈분석.
// "KB Bond"·"KB Fed Watch" 둘 다 이슈분석(오너 지시 2026-09-24 — "KB Fed
// Watch는 이슈분석에 포함한다", 처음엔 "나머지는 제외"로 뺐다가 정정).
// "KB Credit Weekly"는 여전히 제외 대상(크레딧 스프레드 코멘트, 별도
// 지시 없음).
const TAB3_ISSUE_TITLES = new Set(["KB Bond", "KB Fed Watch"]);
const tab3Rows = await fetchList("3");
for (const r of tab3Rows) {
  const date = r.publicDate;
  if (!date || new Date(date) < cutoff) continue;
  if (!TAB3_ISSUE_TITLES.has(String(r.docTitle ?? "").trim())) continue;
  collected.push({
    id: r.documentid,
    date,
    title: (r.docTitleSub || r.docTitle || "").trim(),
    analyst: r.analystNm ?? "",
    summary: "",
    pdfUrl: r.urlLink || null,
    topic: "이슈분석",
  });
}

// 2) 자산배분/매크로(tab=2) — Weekly/주간 제외, FX/환율은 환율분석.
const tab2Rows = await fetchList("2");
for (const r of tab2Rows) {
  const date = r.publicDate;
  if (!date || new Date(date) < cutoff) continue;
  const docTitle = String(r.docTitle ?? "").trim();
  const docTitleSub = String(r.docTitleSub ?? "").trim();
  if (!docTitle) continue;
  if (WEEKLY_RE.test(`${docTitle} ${docTitleSub}`)) continue;
  const folderTail = String(r.foldertemplate ?? "").split(">").pop()?.trim() ?? "";
  const isFx = FX_RE.test(docTitle) || FX_RE.test(folderTail);
  collected.push({
    id: r.documentid,
    date,
    title: (docTitleSub || docTitle).trim(),
    analyst: r.analystNm ?? "",
    summary: "",
    pdfUrl: r.urlLink || null,
    topic: isFx ? "환율분석" : "이슈분석",
  });
}

if (collected.length === 0) {
  console.error("✗ 파싱 결과 0건. API 구조가 바뀌었을 수 있음.");
  process.exit(1);
}
console.log(`✔ 파싱 완료: ${collected.length}건`);
console.log(
  "  샘플:",
  collected.slice(0, 8).map((i) => `[${i.topic}] ${i.date} — ${i.title}`),
);

if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

const byTopic = new Map();
for (const it of collected) {
  if (!byTopic.has(it.topic)) byTopic.set(it.topic, []);
  byTopic.get(it.topic).push({
    id: it.id,
    date: it.date,
    title: it.title,
    analyst: it.analyst,
    summary: it.summary,
    pdfUrl: it.pdfUrl,
  });
}

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;

let totalSent = 0;
for (const [topic, items] of byTopic) {
  const up = await fetch(IMPORT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ items, source: "KB증권", topic }),
  });
  const upBody = await up.text();
  if (!up.ok) {
    console.error(`✗ [${topic}] 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`✔ [${topic}] 앱 전송 완료 (${items.length}건): ${upBody}`);
  totalSent += items.length;
}
console.log(`\n✔ 총 ${totalSent}건 전송 완료`);
