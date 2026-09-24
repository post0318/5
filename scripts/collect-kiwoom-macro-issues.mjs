/**
 * 키움증권 "이슈분석"/"환율분석" 수집기 — 거시경제 > 이슈분석/환율분석 탭
 * 전용(오너 지시 2026-09-24). `collect-kiwoom-research.mjs`(종목·산업분석,
 * `kr_research`)와는 완전히 별개 대상·스키마·라우트(`macro_issues`,
 * `/api/cron/macro-issues`)라 별도 스크립트로 뺐다.
 *
 * 이슈분석: 게시판 코드 **IA**(rMenuGbNm "이슈분석", 실측 확인 — FOMC/금통위
 * 리뷰·프리뷰, 물가, 예산안 등 진짜 거시 이슈). "기업/산업분석" 메뉴
 * 아래에도 이름이 같은 "이슈분석"(코드 CS)이 있는데 실측 내용이 "키움리서치
 * 관심종목(N월 N주)" 반복 시리즈라 대상이 아니다(오너 지시 — "키움증권은
 * 경제전략의 이슈분석만 대상이 된다").
 *
 * 환율분석: 게시판 코드 **FE**(rMenuGbNm "일간환율전망", "09/23 달러,
 * 강보합권 등락" 같은 데일리 환율 코멘트, 오너 지시 — "키움증권은 환율전망이
 * 대상이 된다").
 *
 * 목록/PDF 엔드포인트는 `collect-kiwoom-research.mjs`와 동일한 방식
 * (bbn.kiwoom.com 내부 JSON AJAX, 로그인 불필요) — 자세한 배경은 그 파일
 * 주석 참고.
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-kiwoom-macro-issues.mjs
 *   node scripts/collect-kiwoom-macro-issues.mjs --days=30 --dry-run
 */

import { readFileSync } from "node:fs";
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
const DAYS = Number(ARGS.find((a) => a.startsWith("--days="))?.split("=")[1]) || 7;
const MAX_PAGES = Number(ARGS.find((a) => a.startsWith("--pages="))?.split("=")[1]) || 10;

const IMPORT_URL = (ENV.MACRO_ISSUES_IMPORT_URL || "https://5-topaz-five.vercel.app/api/cron/macro-issues").trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim();
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LIST_BASE = "https://bbn.kiwoom.com/research/SResearch";
const PDF_BASE = "https://bbn.kiwoom.com/research/SPdfFileView";
const PAGE_SIZE = 15;

const BOARDS = [
  { rMenuGb: "IA", topic: "이슈분석" },
  { rMenuGb: "FE", topic: "환율분석" },
];

function isoDate(dotted) {
  const m = String(dotted).trim().match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

async function fetchPage(rMenuGb, page) {
  const res = await fetch(`${LIST_BASE}${rMenuGb}ListAjax`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Referer: `https://bbn.kiwoom.com/research/VAnal${rMenuGb}View`,
      "User-Agent": UA,
    },
    body: new URLSearchParams({ pageNo: String(page), stdate: "", eddate: "", f_keyField: "", f_key: "" }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function collectBoard(board, cutoff) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await fetchPage(board.rMenuGb, page);
    const rows = data?.researchList ?? [];
    if (rows.length === 0) break;
    let stop = false;
    for (const r of rows) {
      const date = isoDate(r.makeDt);
      if (!date) continue;
      if (new Date(date) < cutoff) {
        stop = true;
        break;
      }
      const title = String(r.titl ?? "").trim();
      if (isEtfOrEtpContent(title)) continue;
      out.push({
        id: `${board.rMenuGb}:${r.sqno}`,
        date,
        title,
        analyst: r.workId ?? "",
        summary: "",
        pdfUrl: r.attaFile
          ? `${PDF_BASE}?rMenuGb=${board.rMenuGb}&attaFile=${encodeURIComponent(r.attaFile)}&makeDt=${encodeURIComponent(r.makeDt)}`
          : null,
        topic: board.topic,
      });
    }
    if (stop || rows.length < PAGE_SIZE) break;
    await sleep(300);
  }
  return out;
}

console.log(`▶ 키움증권 이슈분석/환율분석 수집: 최근 ${DAYS}일`);
const cutoff = new Date(new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10));
const collected = [];
for (const board of BOARDS) {
  const items = await collectBoard(board, cutoff);
  console.log(`  ${board.rMenuGb}(${board.topic}): ${items.length}건`);
  collected.push(...items);
  await sleep(300);
}

if (collected.length === 0) {
  console.error("✗ 파싱 결과 0건. 페이지 구조가 바뀌었을 수 있음.");
  process.exit(1);
}
console.log(`✔ 파싱 완료: 총 ${collected.length}건`);
console.log(
  "  샘플:",
  collected.slice(0, 5).map((i) => `[${i.topic}] ${i.date} — ${i.title}`),
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
    body: JSON.stringify({ items, source: "키움증권", topic }),
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
