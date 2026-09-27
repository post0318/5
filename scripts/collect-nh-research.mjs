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
 * **ESG 제외·비상장 인사이트 분리(오너 지시, 2026-09-24 — "nh랑
 * 삼성증권도 카테고리별 분류를 부탁한다"에 따른 조사로 발견)**: 라벨 65개
 * 중 "[NH ESG Research]"류는 공용 필터(`isEsgContent`, "esg는 공통으로
 * 제외처리")로 제외. "[NH 비상장]"류는 일반 산업분석이 아니라
 * `source:"NH투자증권 비상장리서치"`로 별도 전송(오너 지시 — "국내 비상장은
 * 종목분석 인사이트로 해외 비상장은 그대로 산업분석으로 유지" — 이 게시판은
 * 국내라 대상. 삼성증권의 해외 비상장 콘텐츠는 그대로 산업분석 유지).
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
import { enrichResearch, readPdfText } from "./lib/research-extract.mjs";
import { isEsgContent, isCommonExcludedContent } from "./lib/exclude-filters.mjs";

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
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://macroresearch.vercel.app/api/cron/total-research"
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
// "동 자료상 투자의견이 제시된 기업 중 별도의 언급이 없는 한, NH투자증권은
// 해당기업의 발행주식 등을 1% 이상 보유하고 있지 않습니다" 같은 컴플라이언스
// 고지 문구가 헤더 스킵 이후에도 남아 발췌에 반복적으로 섞여 들어갔다(오너
// 지적, 2026-09 — "이거 반복인데 이거는 주제와 벗어나는 문구다").
const COMPLIANCE_LINE_RE = /1%\s*이상\s*보유/;
function excerptFromPdfText(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const anchor = lines.findIndex((l) => /Note\s*[│|]/.test(l));
  const bodyLines = anchor >= 0 ? lines.slice(anchor + 3) : lines.slice(4);
  const flat = bodyLines
    .filter((l) => l.length >= 10 && !COMPLIANCE_LINE_RE.test(l))
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!flat) return "";
  if (flat.length <= EXCERPT_LEN) return flat;
  const cut = flat.slice(0, EXCERPT_LEN);
  const boundary = Math.max(cut.lastIndexOf("다."), cut.lastIndexOf("요."), cut.lastIndexOf("함."));
  return (boundary > EXCERPT_LEN * 0.5 ? cut.slice(0, boundary + 1) : cut) + "…";
}

// 헤더 블록의 "Buy(유지)"·"목표주가 30,000원 (상향)" 줄은 공용 추출기
// (research-extract.mjs)의 국내 규칙·PDF 앞부분 등급 표기로 처리한다.
async function extractPdfExcerpt(pdfUrl) {
  const pdfText = await readPdfText(pdfUrl);
  if (pdfUrl && !pdfText) console.warn(`  ⚠ PDF 본문 추출 실패 (${pdfUrl})`);
  return { summary: pdfText ? excerptFromPdfText(pdfText) : "", pdfText };
}

// ditCd: 01=기업/산업분석 · 03=해외주식 · 02=투자전략 · 04=FICC ·
// 05=자산관리솔루션 · 06=모닝미팅브리프(오너가 리서치 포털 스크린샷으로
// 확인한 전체 메뉴 — collect-nh-overseas/-strategy-research.mjs 흡수).
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
  const raw = new TextDecoder("euc-kr").decode(await res.arrayBuffer());
  // 제목 필드에 이스케이프 안 된 raw 탭 문자가 섞여 나오는 경우가 실측
  // 확인돼(2026-09-24, "NH 글로벌 주식시장 투자 포인트 10월호\t") JSON.parse가
  // "Bad control character" 로 죽는다 — 문자열 값 안의 제어문자를 공백으로
  // 정리한 뒤 파싱한다(JSON 구조 밖의 개행/탭도 공백으로 바뀌지만 무해).
  const text = raw.replace(/[\x00-\x1F]/g, " ");
  return JSON.parse(text);
}

// ── 해외기업분석(구 collect-nh-overseas-research.mjs) ──────────────────
// "[해외기업분석/Apple] 아이폰18, 균형 잡힌 전략" — 회사명과 본문 제목 분리.
const OVERSEAS_TITLE_RE = /^\[해외기업분석(?:\s+\S+)?\s*\/\s*([^\]]+)\]\s*(.+)$/;
const STRATEGY_INSIDE_RE = /^\[전략\s*인사이드\/([^\]]+)\]\s*(.+)$/;
const BRACKET_RE = /^\[([^\]]+)\]\s*(.+)$/;
const NON_US_COUNTRY_RE = /중국|일본|유럽|홍콩|대만|동남아|한국|인도/;

/** 한글/영문 회사명 → 미국 티커(네이버 해외종목 자동완성). 실패하면 null. */
const usCache = new Map();
async function resolveUsTicker(name) {
  const key = name.trim();
  if (usCache.has(key)) return usCache.get(key);
  let hit = null;
  try {
    const res = await fetch(`https://ac.stock.naver.com/ac?q=${encodeURIComponent(key)}&target=stock`, {
      headers: { "User-Agent": UA, accept: "application/json" },
    });
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

// ── 투자전략/FICC/자산관리솔루션/모닝미팅브리프(구 collect-nh-strategy-research.mjs) ──
const STRATEGY_BOARDS = [
  { ditCd: "02", label: "투자전략", forceMarket: null },
  { ditCd: "04", label: "FICC", forceMarket: "us" },
  { ditCd: "05", label: "자산관리솔루션", forceMarket: null },
  { ditCd: "06", label: "모닝미팅브리프", forceMarket: "us" },
];
// 리포트가 올라온 NH 게시판 표시(rsh_ppr_dit_cd) — 대조·검수용 메타(서버는 무시).
const NH_BOARD_LABEL = { "01": "기업/산업분석", "02": "투자전략", "03": "해외주식", "04": "FICC", "05": "자산관리솔루션", "06": "모닝미팅브리프" };
const nhBoard = (ditCd) => `NH투자증권 > ${NH_BOARD_LABEL[ditCd] ?? "리서치"}(rsh_ppr_dit_cd=${ditCd})`;

const DECOR_RE = /^◆\s*|\s*◆$/g;
function decodeEntities(s) {
  return s
    .replace(/&lsquo;|&rsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
const NON_US_RE =
  /중국|차이나|China|일본|엔화|엔캐리|Japan|유럽|Europe|베트남|Vietnam|인도(?!네시아)|India\b|신흥국|이머징|Emerging|브라질|Brazil|대만|Taiwan/i;
const US_HINT_RE = /미국|\bUS\b|나스닥|Nasdaq|S&P|다우|연준|\bFed\b|FOMC|월가|Wall Street|Global\s?Markets/i;
function classifyMarket(text) {
  if (NON_US_RE.test(text)) return null;
  if (US_HINT_RE.test(text)) return "us";
  return "kr";
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
  const json = await fetchPage("01", cursor);
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
          board: nhBoard("01"),
        });
      }
      continue;
    }
    // 코드 0개 — ser_cd_nm 이 "산업"이면 산업분석/투자전략으로 수집, 그 외
    // ("기업"인데 코드 매칭 실패, 해외종목만 다룸 등)는 기존처럼 건너뜀.
    if (r.rsh_ppr_ser_cd_nm !== "산업") continue;
    // PDF 링크가 없으면 화면에서 클릭할 게 없어 그대로 버린다(오너 지적,
    // 2026-09 — "링크가 없다 링크안되면 삭제다"). "Weekly KR ETF Flows" 등
    // 일부 항목은 NH API 응답 자체에 첨부파일 필드가 비어있음(실측).
    if (!r.hpge_fle_url_cts) continue;
    const { sector, title } = sectorLabelAndTitle(r.rsh_ppr_til_cts);
    // ESG 공용 제외(오너 지시 2026-09-24 — "esg는 공통으로 제외처리",
    // "[NH ESG Research]" 라벨 발견 계기).
    if (isEsgContent(sector) || isEsgContent(title)) continue;
    // 비상장 라벨("[NH 비상장]")은 일반 산업분석이 아니라 "비상장 리서치"로
    // 별도 전송(오너 지시 2026-09-24 — "국내 비상장은 종목분석 인사이트로
    // 해외 비상장은 그대로 산업분석으로 유지" — 이 게시판은 국내(market
    // 기본값 "kr")라 인사이트 대상. 삼성증권처럼 해외(market:"us") 비상장은
    // 그대로 산업분석 유지, 손대지 않음).
    const unlisted = /비상장/.test(sector);
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
      board: nhBoard("01"),
      unlisted,
    });
  }

  const last = rows[rows.length - 1];
  cursor = { no: last.rsh_ppr_no, date: last.rsh_ppr_dru_dt, time: last.rsh_ppr_dru_tm };
  await sleep(400);
}

// 해외기업분석 — "03"(해외주식 전용, 주력) + "01"(기업/산업분석, 드물게 해외
// 리포트 섞임) 스캔. "01"은 위 국내 루프와 별개로 다시 훑는다(원본 3개
// 스크립트일 때도 각자 따로 "01"을 불렀다 — 동작 동일, 중복 호출 신설 아님).
console.log(`▶ NH투자증권 해외기업분석 수집: 최근 ${DAYS}일 (게시판 03+01)`);
const overseasRawRows = [];
for (const ditCd of ["03", "01"]) {
  let oCursor = null;
  let oStop = false;
  for (let page = 1; page <= MAX_PAGES && !oStop; page++) {
    const json = await fetchPage(ditCd, oCursor);
    const rows = parseRows(json);
    if (rows.length === 0) break;
    for (const r of rows) {
      const date = isoDate(r.rsh_ppr_dru_dt);
      if (date && new Date(date) < cutoff) {
        oStop = true;
        break;
      }
      overseasRawRows.push({ ...r, __ditCd: ditCd });
    }
    const last = rows[rows.length - 1];
    oCursor = { no: last.rsh_ppr_no, date: last.rsh_ppr_dru_dt, time: last.rsh_ppr_dru_tm };
    await sleep(400);
  }
}
console.log(`  목록 ${overseasRawRows.length}건 중 해외기업분석 매핑 시도...`);
for (const r of overseasRawRows) {
  const rawTitle = String(r.rsh_ppr_til_cts ?? "");
  const tm = rawTitle.match(OVERSEAS_TITLE_RE);
  if (tm) {
    const hit = await resolveUsTicker(tm[1]);
    if (!hit) continue;
    if (isCommonExcludedContent(tm[2].trim(), "기업")) continue;
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
      board: nhBoard(r.__ditCd),
      market: "us",
    });
    continue;
  }
  // 산업/전략 폴백은 "03"(해외주식 전용)에서만 — "01"은 평범한 국내 종목도
  // "[종목명] 헤드라인" 형식을 쓰기 때문(실측으로 확인한 버그 재발 방지).
  if (r.__ditCd !== "03") continue;
  const sm = rawTitle.match(STRATEGY_INSIDE_RE);
  if (sm) {
    if (NON_US_COUNTRY_RE.test(sm[1])) continue;
    if (!r.hpge_fle_url_cts) continue;
    if (isCommonExcludedContent(sm[2].trim(), "산업")) continue;
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
      board: nhBoard(r.__ditCd),
      market: "us",
    });
    continue;
  }
  const gm = rawTitle.match(BRACKET_RE);
  if (gm && !NON_US_COUNTRY_RE.test(gm[1]) && r.hpge_fle_url_cts && !isCommonExcludedContent(`${gm[1].trim()} ${gm[2].trim()}`, "산업")) {
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
      board: nhBoard(r.__ditCd),
      market: "us",
    });
  }
}

// 투자전략/FICC/자산관리솔루션/모닝미팅브리프(02/04/05/06).
console.log(`▶ NH투자증권 투자전략/FICC/자산관리솔루션/모닝미팅브리프 수집: 최근 ${DAYS}일`);
for (const board of STRATEGY_BOARDS) {
  let sCursor = null;
  let sStop = false;
  for (let page = 1; page <= MAX_PAGES && !sStop; page++) {
    const json = await fetchPage(board.ditCd, sCursor);
    const rows = parseRows(json);
    if (rows.length === 0) break;
    for (const r of rows) {
      const date = isoDate(r.rsh_ppr_dru_dt);
      if (date && new Date(date) < cutoff) {
        sStop = true;
        break;
      }
      // 링크가 없으면 화면에서 클릭할 게 없어 그대로 버린다(오너 지적, 2026-09-27 — "링크가 null 안열리면 수집하지마").
      // 위 산업(01) 게시판과 같은 규칙 — "테마/이슈 10시 Check" 등 일부 항목이 첨부파일 필드 자체가 비어있음(실측).
      if (!r.hpge_fle_url_cts) continue;
      const rawTitle = decodeEntities(String(r.rsh_ppr_til_cts ?? "")).replace(DECOR_RE, "").trim();
      const bm = rawTitle.match(BRACKET_RE);
      let stockName = bm ? bm[1].trim() : r.rsh_ppr_ser_cd_nm || board.label;
      const title = bm ? bm[2].trim() : rawTitle;
      if (board.ditCd === "04" && /대체투자|부동산/.test(stockName) && !/원자재|commodit/i.test(`${stockName} ${title}`)) continue;
      if (board.ditCd === "04") stockName = `FICC · ${stockName}`;
      const isDomesticFicc = board.ditCd === "04" && /\(국내\)/.test(stockName);
      const market = isDomesticFicc ? "kr" : (board.forceMarket ?? classifyMarket(`${stockName} ${title}`));
      if (!market) continue;
      if (isCommonExcludedContent(`${stockName} ${title}`, "산업")) continue;
      collected.push({
        id: r.rsh_ppr_no,
        date,
        title: title || rawTitle,
        stockName,
        symbol: null,
        analyst: r.rsh_ppr_dru_emp_fnm ?? "",
        opinion: "",
        targetPrice: null,
        summary: "",
        pdfUrl: r.hpge_fle_url_cts || null,
        views: null,
        category: "산업",
        board: nhBoard(board.ditCd),
        market,
      });
    }
    const last = rows[rows.length - 1];
    sCursor = { no: last.rsh_ppr_no, date: last.rsh_ppr_dru_dt, time: last.rsh_ppr_dru_tm };
    await sleep(400);
  }
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
  const { summary, pdfText } = excerptCache.get(it.pdfUrl);
  it.summary = summary;
  it.pdfText = pdfText;
  if (!it.summary) excerptFailCount++;
}
console.log(`✔ 발췌 완료 (실패 ${excerptFailCount}건, PDF ${excerptCache.size}개)`);
// 투자의견·목표주가 — 공용 추출기(산업분석은 내부에서 건너뜀). PDF 는 위에서 이미 읽었다.
await enrichResearch(collected, { market: "kr", usePdf: false });
console.log("  예시:", collected[0]?.summary || "(없음)");

if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

// 비상장(unlisted) 항목은 일반 산업분석 풀과 섞이지 않도록 별도 source로
// 나눠 전송한다(키움/KB 비상장리서치와 동일 패턴).
const UNLISTED_SOURCE = "NH투자증권 비상장리서치";
// 해외기업분석/투자전략 병합으로 market이 kr/us 둘 다 섞이므로 market×source
// (비상장 여부)로 나눠 전송 — KB/키움 병합본과 동일한 byGroup 패턴.
const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;

const byGroup = new Map();
for (const it of collected) {
  const source = it.unlisted ? UNLISTED_SOURCE : "NH투자증권";
  const market = it.market ?? "kr";
  const key = `${market}::${source}`;
  if (!byGroup.has(key)) byGroup.set(key, { market, source, items: [] });
  byGroup.get(key).items.push({
    id: it.id,
    date: it.date,
    title: it.title,
    stockName: it.stockName,
    symbol: it.symbol ?? null,
    analyst: it.analyst,
    opinion: it.opinion ?? "",
    targetPrice: it.targetPrice ?? null,
    summary: it.summary ?? "",
    pdfUrl: it.pdfUrl,
    views: it.views ?? null,
    category: it.category,
    board: it.board,
  });
}

for (const [, group] of byGroup) {
  const { market, source, items } = group;
  const up = await fetch(IMPORT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ items, source, market }),
  });
  const upBody = await up.text();
  if (!up.ok) {
    console.error(`✗ [${market}/${source}] 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`\n✔ [${market}/${source}] 앱 전송 완료 (${items.length}건): ${upBody}`);
}
