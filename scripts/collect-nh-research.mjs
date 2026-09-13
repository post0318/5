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
 * 산업분석/투자전략(2026-09 추가, 오너 지시 — "한국과 미국 모두 동일하게
 * 수집 기반 구축", 도메스틱은 "한경에서 받아오는 회사는 제외"): 응답에
 * `rsh_ppr_ser_cd_nm` 필드가 이미 "기업"/"산업"을 명시적으로 구분해준다(브라
 * 켓 제목을 추측할 필요가 없음, 실측 확인). 종목코드가 0개인 항목 중
 * `ser_cd_nm === "산업"`인 것만 category:"산업"으로 별도 수집한다(코드 0개
 * + "기업"인 항목은 미상장·코드 매칭 실패라 기존과 동일하게 건너뜀). 제목의
 * "[분류/세부]" 형식은 "/" 뒤쪽을 업종 라벨로 쓴다(예: "[Spot Comment/
 * 자동차산업]" → "자동차산업"), "/" 없으면 대괄호 안 전체를 그대로 라벨로.
 *
 * ⚠️ www.nhsec.com/robots.txt 는 `Disallow: /`(Googlebot 등 주요 크롤러만 예외)다.
 *    다른 예외들과 동일하게 "개인용·로컬 실행·저빈도" 조건으로 오너 승인
 *    (CLAUDE.md 참조, 오너가 "NH투자증권도 로그인없이 가능하다" 직접 확인).
 *    앱 배포본(Vercel)에는 이 수집 코드가 없다.
 *
 * 본문 발췌(2026-09 추가, 유안타증권과 동일 접근): PDF를 내려받아 `pdf-parse`
 * (무료 오픈소스, 로컬 처리)로 텍스트를 뽑는다. NH 리포트는 항상
 * "Industry Note│날짜" 또는 "Company Note│날짜" 줄 다음 2줄(산업명/종목명 +
 * 제목)을 지나면 바로 본문(실측 결과 이미 1~2문장 티저로 시작)이 나와, 그
 * 지점부터 150자 내외만 짧게 저장한다. PDF 원문·전체 본문은 저장하지 않음.
 *
 * ⚠️ 서버가 보낸 항목을 통째로 replace하므로, --days 기본값을 14 → 3으로
 *    좁혀 PDF를 매일 다시 받는 범위를 최소화했다(유안타증권과 동일 이유).
 *    백필은 --days=30 등으로 수동 실행.
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-nh-research.mjs
 *   node scripts/collect-nh-research.mjs --days=30 --pages=10 --dry-run
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
const DAYS = Number(ARGS.find((a) => a.startsWith("--days="))?.split("=")[1]) || 3;
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

const GENERIC_BRACKET_RE = /^\[([^\]]+)\]\s*(.*)$/;
function sectorLabelAndTitle(rawTitle) {
  const m = String(rawTitle ?? "").match(GENERIC_BRACKET_RE);
  if (!m) return { sector: "산업", title: rawTitle };
  const parts = m[1].split("/");
  return { sector: parts[parts.length - 1].trim(), title: m[2].trim() || m[1].trim() };
}

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

// 헤더 블록에 "Buy(유지)" 같은 등급 줄과 "목표주가 30,000원 (상향)" 줄이
// 고정으로 등장한다(Yuanta·KB와 동일 계열 템플릿).
function extractOpinion(text) {
  const m = text.match(/^(Strong Buy|Buy|Hold|Sell|매수|중립|매도)\s*[\(（]/m);
  return m ? m[1] : "";
}
function extractTargetPrice(text) {
  const m = text.match(/목표주가(?:를|는|가)?\s*([\d,]+)\s*(만)?\s*원/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, "")) * (m[2] ? 10000 : 1);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function extractPdfExcerpt(pdfUrl) {
  if (!pdfUrl) return { summary: "", opinion: "", targetPrice: null };
  try {
    const res = await fetch(pdfUrl, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const parser = new PDFParse({ data: buf });
    const { text } = await parser.getText();
    await parser.destroy();
    return {
      summary: excerptFromPdfText(text),
      opinion: extractOpinion(text),
      targetPrice: extractTargetPrice(text),
    };
  } catch (err) {
    console.warn(`  ⚠ PDF 본문 추출 실패 (${pdfUrl}): ${err.message}`);
    return { summary: "", opinion: "", targetPrice: null };
  }
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
// 항목 날짜가 'YYYY-MM-DD'(=UTC 자정)라 컷오프도 자정으로 맞춘다.
// Date.now() 기준 그대로 두면 '정확히 DAYS일 전' 리포트가 시:분 차이로
// 매번 잘려나간다(실측 2026-09: 미래에셋 최신 리포트가 3시간 차이로 탈락).
const cutoff = new Date(new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10));
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
    if (!date) continue;
    const codes = String(r.rsh_ppr_iem_cd_pcl ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter((c) => /^\d{6}$/.test(c));
    if (codes.length > 0) {
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
          category: "기업",
        });
      }
      continue;
    }
    // 코드 0개 — ser_cd_nm 이 "산업"이면 산업분석/투자전략으로 수집, 그 외
    // ("기업"인데 코드 매칭 실패, 해외종목만 다룸 등)는 기존처럼 건너뜀.
    if (r.rsh_ppr_ser_cd_nm !== "산업") continue;
    const { sector, title } = sectorLabelAndTitle(r.rsh_ppr_til_cts);
    collected.push({
      id: r.rsh_ppr_no,
      date,
      title,
      stockName: sector,
      symbol: null,
      analyst: r.rsh_ppr_dru_emp_fnm ?? "",
      opinion: "",
      summary: "",
      pdfUrl: r.hpge_fle_url_cts || null,
      views: null,
      category: "산업",
    });
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

// 산업 리포트는 종목코드마다 항목을 복제하지만 PDF는 하나라, pdfUrl 기준으로
// 캐시해서 같은 PDF를 여러 번 받지 않는다.
console.log(`▶ PDF 본문 발췌 중...`);
const excerptCache = new Map();
let excerptFailCount = 0;
for (const it of collected) {
  if (!it.pdfUrl) continue;
  if (!excerptCache.has(it.pdfUrl)) {
    excerptCache.set(it.pdfUrl, await extractPdfExcerpt(it.pdfUrl));
    await sleep(500);
  }
  const { summary, opinion, targetPrice } = excerptCache.get(it.pdfUrl);
  it.summary = summary;
  // 산업분석은 특정 종목 얘기가 아니므로 목표주가·투자의견 개념이 없음 —
  // 본문 발췌(summary)는 유지하되 등급·목표가는 채우지 않는다.
  if (it.category !== "산업") {
    it.opinion = opinion;
    it.targetPrice = targetPrice;
  }
  if (!it.summary) excerptFailCount++;
}
console.log(`✔ 발췌 완료 (실패 ${excerptFailCount}건, PDF ${excerptCache.size}개)`);
console.log("  예시:", collected[0]?.summary || "(없음)");

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
