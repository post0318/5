/**
 * 신한투자증권 "기업분석" 리포트 — 로컬 수집기.
 *
 * bbs2.shinhansec.com 의 게시판 JSON API(로그인 불필요, 실제 브라우저 XHR을
 * 그대로 재현 — 페이지 소스에는 없고 클라이언트 JS가 호출)에서 최신 리포트를
 * 가져와 앱(Vercel)의 DB 적재 라우트로 전송한다.
 *
 * ⚠️ bbs2.shinhansec.com/robots.txt 는 `Disallow: /` 다. 다른 예외들과 동일하게
 *    프로젝트 오너가 "개인용·로컬 실행·저빈도" 조건으로 예외 승인(CLAUDE.md 참조).
 *    앱 배포본(Vercel)에는 이 수집 코드가 없다 — DB 적재 라우트는 결과를 받기만 함.
 *
 * 목표주가 PDF 폴백(2026-09 추가): "Review" 후속 리포트는 본문(f7)에
 * "목표주가는 유지"라고만 쓰고 숫자를 다시 안 적는 경우가 많다(실측 —
 * LS 사례). 그 경우 PDF 표지 헤더("목표주가 600,000 원 (유지)")에는 항상
 * 숫자가 있어(다른 브로커 PDF와 동일 패턴) 본문에서 못 찾았을 때만 PDF를
 * 내려받아 재시도한다 — 매번 받지 않고 폴백일 때만이라 비용 최소화.
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-shinhan-research.mjs             # 최근 14일, 최대 5페이지
 *   node scripts/collect-shinhan-research.mjs --days=30 --pages=10
 *   node scripts/collect-shinhan-research.mjs --dry-run   # 전송 안 하고 파싱 결과만
 *
 * ── 설정 (.env.local, 선택) ─────────────────────────────────────────
 *   SHINHAN_RESEARCH_IMPORT_URL="https://5-topaz-five.vercel.app/api/cron/shinhan-research"
 *   CRON_SECRET="앱에 설정한 값이 있으면"
 */

import { readFileSync } from "node:fs";
import { PDFParse } from "pdf-parse";

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
// 페이지당 실제로 넘어가는 항목 수가 적어(실측: 60일치 커버하는 데 23페이지
// 필요) 기본값 5는 14일 기본 조회 기간도 못 채우고 끊길 수 있었다(실측
// 확인 — HD현대일렉트릭 7/29자 리포트가 누락됐었음). 여유 있게 10으로 상향.
const MAX_PAGES = Number(ARGS.find((a) => a.startsWith("--pages="))?.split("=")[1]) || 10;

const IMPORT_URL = (
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://5-topaz-five.vercel.app/api/cron/shinhan-research"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim(); // 로컬 수동 실행 시 CRON_SECRET 없어도 인증 가능(라우트가 x-app-token도 허용)

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BASE = "https://bbs2.shinhansec.com/bbs/list/gicompanyanalyst";

const isoDate = (s) => {
  const m = String(s).trim().match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

// 반복되는 "신한생각: ..." 헤더가 본문에 여러 번 겹쳐 나오는 원본 특성상,
// 앞부분만 발췌(요약 카드에 이미 노출되는 분량 정도)하고 개행은 공백으로 접는다.
const EXCERPT_LEN = 300;
function excerpt(text) {
  const flat = String(text ?? "")
    .replace(/&middot;/g, "·")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return flat.length > EXCERPT_LEN ? `${flat.slice(0, EXCERPT_LEN)}…` : flat;
}

// 본문(f7) 뒷부분에 "매수 의견과 목표주가 65만원 유지" 처럼 만원 단위로
// 섞여 나온다 — excerpt()로 자르기 전 원문 전체에서 뽑는다(300자 넘어가는
// 경우가 많음).
function extractTargetPrice(text) {
  const m = String(text ?? "").match(/목표주가(?:를|는|가)?\s*([\d,]+)\s*(만)?원/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, "")) * (m[2] ? 10000 : 1);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function extractTargetPriceFromPdf(pdfUrl) {
  if (!pdfUrl) return null;
  try {
    const res = await fetch(pdfUrl, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const parser = new PDFParse({ data: buf });
    const { text } = await parser.getText();
    await parser.destroy();
    return extractTargetPrice(text);
  } catch (err) {
    console.warn(`  ⚠ PDF 목표주가 추출 실패 (${pdfUrl}): ${err.message}`);
    return null;
  }
}

// 일시적 네트워크 오류("fetch failed"/소켓 리셋 등, 2026-09 실측 —
// bbs2.shinhansec.com이 이따금 연결을 끊어 스케줄 실행 전체가 그 날 통째로
// 실패했다)에도 전체 수집이 죽지 않도록 페이지당 재시도를 둔다. 하루 2회
// 스케줄(오너 지시, 2026-09 — "작성시간과 로드시간의 시차")로도 다음 실행
// 때 자연 복구되지만, 한 번의 일시적 오류로 그 회차 전체를 날리지 않는 게
// 더 안전하다.
async function fetchPage(curPage, startId, attempt = 1) {
  const url = new URL(BASE);
  url.searchParams.set("v", String(Date.now()));
  url.searchParams.set("curPage", String(curPage));
  url.searchParams.set("startPage", String(curPage));
  if (startId) url.searchParams.set("startId", startId);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, "X-Requested-With": "XMLHttpRequest" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.includes("errorWrapper")) throw new Error("게시판 API 404(구조 변경?)");
    return JSON.parse(text);
  } catch (err) {
    if (attempt < 3 && /fetch failed|SocketError|ECONNRESET|ETIMEDOUT/i.test(String(err.message ?? err))) {
      console.warn(`  ⚠ 페이지 ${curPage} 요청 실패(${attempt}회차), 재시도: ${err.message}`);
      await sleep(2000 * attempt);
      return fetchPage(curPage, startId, attempt + 1);
    }
    throw err;
  }
}

console.log(`▶ 신한투자증권 기업분석 리포트 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지`);

// 항목 날짜가 'YYYY-MM-DD'(=UTC 자정)라 컷오프도 자정으로 맞춘다.
// Date.now() 기준 그대로 두면 '정확히 DAYS일 전' 리포트가 시:분 차이로
// 매번 잘려나간다(실측 2026-09: 미래에셋 최신 리포트가 3시간 차이로 탈락).
const cutoff = new Date(new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10));
const items = [];
let startId = undefined;
let stop = false;

for (let page = 1; page <= MAX_PAGES && !stop; page++) {
  const data = await fetchPage(page, startId);
  const list = data.list ?? [];
  if (list.length === 0) break;
  for (const it of list) {
    const date = isoDate(it.f0);
    if (!date) continue;
    if (new Date(date) < cutoff) {
      stop = true;
      break;
    }
    const pdfUrl = it.f3 || null;
    let targetPrice = extractTargetPrice(it.f7);
    if (targetPrice == null && pdfUrl) {
      targetPrice = await extractTargetPriceFromPdf(pdfUrl);
      await sleep(400);
    }
    items.push({
      id: String(it.fn),
      date,
      title: it.f1,
      stockName: it.f2,
      analyst: it.f4,
      opinion: it.f6,
      targetPrice,
      summary: excerpt(it.f7),
      pdfUrl,
      views: Number(it.f5) || null,
    });
  }
  const pages = data.pageInfo?.pages ?? [];
  startId = pages.length > 1 ? pages[1] : undefined;
  if (!startId) break;
  await sleep(400); // 예의상 간격
}

if (items.length === 0) {
  console.error("✗ 파싱 결과 0건. 게시판 구조가 바뀌었을 수 있음.");
  process.exit(1);
}

console.log(`✔ 파싱 완료: ${items.length}건`);
console.log("  최근 3건:", items.slice(0, 3).map((i) => `${i.date} ${i.stockName} — ${i.title}`));

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
  body: JSON.stringify({ items, source: "신한투자증권" }),
});
const upBody = await up.text();
if (!up.ok) {
  console.error(`✗ 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
  process.exit(1);
}
console.log(`\n✔ 앱 전송 완료: ${upBody}`);
