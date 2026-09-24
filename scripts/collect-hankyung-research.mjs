/**
 * 한경 컨센서스(consensus.hankyung.com) — 로컬 수집기.
 *
 * 한국경제신문이 거의 모든 증권사의 리포트를 한곳에 모아놓은 통합 목록.
 * "제공출처" 컬럼에 실제 작성 증권사명이 그대로 나와 여러 증권사를 한 번에
 * 커버한다(신한·하나·한화·유안타·교보 개별 스크립트를 대체하진 않고 보완 —
 * 같은 리포트가 두 소스에 중복 저장될 수 있음, source 로 구분되니 UI에서는
 * 중복 배지로 보일 뿐 기능상 문제는 없음). 로그인 없이 평범한 GET, 페이지네이션도
 * `&now_page=N`. "기업" 분류 제목이 "종목명(코드) 제목" 형식이라 이름 검색 없이
 * 코드를 바로 뽑는다. PDF 다운로드도 로그인 없이 바로 열림(`/analysis/downpdf?
 * report_idx=N`, 확인됨).
 *
 * ⚠️ consensus.hankyung.com/robots.txt 는 `Disallow: /` 다. 이 사이트는 개별
 *    증권사의 "자사 리서치 공개"가 아니라 한국경제신문이 여러 증권사 자료를
 *    재가공한 3자 편집 서비스라는 점이 다른 예외들과 다름 — 오너가 이 차이를
 *    인지한 상태로 "개인용·로컬 실행·저빈도" 조건 예외 승인(CLAUDE.md 참조).
 *
 * ⚠️ 유안타증권 재포함(오너 지시, 2026-09): 처음엔 자체 스크립트
 *    (collect-yuanta-research.mjs)와 중복을 막으려고 여기서 제외했으나,
 *    myasset.com 자체 스크래핑이 발췌·목표주가·투자의견 추출에서 계속
 *    실패해(오너 확인) 한경 경유(구조화된 적정가격/투자의견 컬럼 + PDF 발췌)
 *    로 전환한다. 같은 리포트가 유안타 자체 스크립트와 중복 저장될 수 있지만
 *    _id가 소스별로 네임스페이스돼 있고 읽기 단계에서 제목 기준 dedupe도
 *    되어 있어(getShinhanResearchBySymbol) 기능상 문제 없음.
 *
 * 투자의견/목표주가(2026-09 갱신): 처음엔 PDF 본문에서 정규식으로 추측했으나,
 * 검색폼 파라미터 `report_type=CO`("기업" 탭 — 사이트 UI에서 종목 검색 시
 * 자동으로 붙는 값, `_text_change('2','CO','기업')`에서 역추적)를 목록
 * 요청에 그대로 붙이면 목록 자체에 "적정가격"·"투자의견" 컬럼이 추가로
 * 나온다(오너가 실제 사이트 화면에서 이 컬럼을 보고 지적, 2026-09).
 * PDF를 열 필요 없이 구조화된 값을 그대로 쓸 수 있어 훨씬 정확하다.
 *
 * 본문 발췌(2026-09 추가): 위 컬럼과 별개로, 본문 요약은 여전히 PDF를
 * 내려받아 `pdf-parse`로 텍스트를 뽑는다. 이 사이트는 14곳 넘는 증권사
 * 리포트가 섞여 있어 브로커마다 PDF 템플릿이 전혀 달라, 유안타·NH·KB처럼
 * 고정 앵커 문구를 쓸 수 없다. 대신 "긴 줄(20자 이상)이면서 한글 비율이
 * 40% 이상인 줄만" 프로즈로 간주해 이어붙이는 범용 방식을 쓴다 — 재무 표
 * (숫자 나열)·이메일·짧은 라벨은 한글 비율이 낮아 자연히 걸러지고, 실제
 * 문장 위주로 150자 내외가 뽑힌다(완벽하진 않지만 실측 결과 대부분 읽을
 * 만한 수준). PDF 원문·전체 본문은 저장하지 않음.
 *
 * ⚠️ 서버가 보낸 항목을 통째로 replace하므로, --days 기본값을 7 → 3으로
 *    좁혀 PDF를 매일 다시 받는 범위를 최소화했다(유안타증권과 동일 이유).
 *    백필은 --days=30 등으로 수동 실행.
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-hankyung-research.mjs
 *   node scripts/collect-hankyung-research.mjs --days=30 --pages=10 --dry-run
 */

import { readFileSync } from "node:fs";
import { PDFParse } from "pdf-parse";

// IN/MA(산업/시장) 항목 중 대괄호 업종 태그가 없는 제목이 실은 특정 국내
// 종목 얘기인 경우가 있다(실측, 오너 지적 2026-09 — 메리츠증권 "HD현대중공업
// 의 엔진 증설 발표 - 조선주 재반등 신호탄", 유진투자증권 "플래닛랩스, 소버린
// 수요에 분기 최대 실적" 등이 종목 리포트인데 "산업"으로 새고 있었음). DS
// 수집기와 동일한 방식("제목이 그 이름으로 시작하는 것 중 가장 긴 이름")으로
// corpcodes.json(3,930개, DART_API_KEY 불필요)에서 매칭되면 기업분석으로
// 승격한다 — 해외 개별종목(플래닛랩스 등)까지는 다루지 않음(네이버 자동완성
// 해석이 필요해 국내보다 비용이 크고, 이 게시판은 국내·해외가 섞여 있어
// 오탐 위험도 큼 — 국내 매칭만으로도 확인된 사례 다수 해결).
const CORPS = JSON.parse(
  readFileSync(new URL("../src/lib/markets/kr/data/corpcodes.json", import.meta.url), "utf8"),
).sort((a, b) => b.n.length - a.n.length);
// startsWith만으로는 "신흥국 실적 상향..."이 "신흥"(실제 상장사, 004080)의
// 접두어와 우연히 겹쳐 오매칭되는 사례가 실측됨(제목이 자연어 문장이라
// DS의 "[업종] 종목명 - 부제" 처럼 구조화돼 있지 않아 이 게시판에서 특히
// 위험) — 매칭 뒤 남는 글자가 없거나(제목이 회사명으로 끝남), 공백/구두점/
// 영숫자이거나, 한글 조사(의/은/는/이/가/을/를/과/와/도/만 등)로 시작할
// 때만 인정한다. "국"처럼 조사가 아닌 한글 음절이 바로 이어지면 다른 단어의
// 일부로 보고 기각.
const KR_PARTICLES = ["의", "은", "는", "이", "가", "을", "를", "과", "와", "도", "만", "에", "께", "이나", "나", "라도", "마저", "조차", "밖에", "부터", "까지", "로", "으로"];
function resolveKrStock(text) {
  const t = text.trim();
  for (const c of CORPS) {
    if (!t.startsWith(c.n)) continue;
    const rest = t.slice(c.n.length);
    if (!rest || !/^[가-힣]/.test(rest)) return { symbol: c.s, stockName: c.n }; // 제목이 그대로 끝나거나 공백/구두점/영숫자로 이어짐
    const particle = KR_PARTICLES.find((p) => rest.startsWith(p));
    if (particle && !/^[가-힣]/.test(rest.slice(particle.length))) return { symbol: c.s, stockName: c.n }; // 조사 뒤 공백 등으로 끊김
    // 조사가 아닌 한글 음절이 바로 이어지면 다른 단어의 일부 — 기각, 더 짧은 후보로 계속.
  }
  return null;
}

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
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://macroresearch.vercel.app/api/cron/shinhan-research"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim(); // 로컬 수동 실행 시 CRON_SECRET 없어도 인증 가능(라우트가 x-app-token도 허용)
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LIST_URL = "https://consensus.hankyung.com/analysis/list";
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function stripHtml(s) {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, " ")
    .trim();
}

// 사이트 기본 pagenum(20/페이지)은 하루치도 못 채울 만큼 작다(실측: 하루
// 평균 20~40건 전체 리포트) — 90일 백필 시 기본값으로는 MAX_PAGES 안에서
// 최근 며칠치만 훑고 끝나버려 특정 종목(예: 삼성전자)이 통째로 빠질 수
// 있었다(실측 확인). 500으로 키워 페이지당 실제 며칠씩 커버되게 한다.
const PAGE_SIZE = 500;

async function fetchPage(page, sdate, edate, reportType = "CO") {
  const url = new URL(LIST_URL);
  url.searchParams.set("sdate", sdate);
  url.searchParams.set("edate", edate);
  url.searchParams.set("now_page", String(page));
  url.searchParams.set("pagenum", String(PAGE_SIZE));
  url.searchParams.set("report_type", reportType); // CO=기업(적정가격/투자의견 컬럼 추가), IN=산업, MA=시장
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// 행 단위로 잘라 필드별로 매칭한다(느슨한 구간 뒤 선택 그룹을 바로 붙이면
// 정규식이 아무것도 건너뛰지 않고 즉시 매칭을 끝내버리는 문제가 있었음 —
// 유안타증권 스크립트에서 겪은 것과 동일한 함정, 여기선 처음부터 회피).
const DATE_RE = /<td[^>]*class="[^"]*txt_number[^"]*">(\d{4}-\d{2}-\d{2})<\/td>/;
const TITLE_RE = /<a href="\/analysis\/downpdf\?report_idx=(\d+)"[^>]*>([^<]+)<\/a>/;
const TARGET_RE = /<td class="text_r txt_number">([\d,]+)<\/td>/;
// 종목명(코드) 형식 — 산업/시장 등 종목 무관 리포트는 report_type=CO 필터로
// 이미 걸러지지만 혹시 모를 예외 대비 그대로 유지.
const STOCK_TITLE_RE = /^(.+?)\((\d{6})\)\s*(.*)$/;

function parseOpinion(text) {
  const t = text.trim();
  return t === "투자의견없음" ? "" : t;
}

function parseItems(html) {
  const items = [];
  for (const rowHtml of html.split(/<tr[^>]*>/).slice(1)) {
    const dateM = rowHtml.match(DATE_RE);
    const titleM = rowHtml.match(TITLE_RE);
    if (!dateM || !titleM) continue;
    const [, reportIdx, rawTitle] = titleM;
    const title = stripHtml(rawTitle);
    const tm = title.match(STOCK_TITLE_RE);
    if (!tm) continue; // 종목코드 형식이 아니면(드묾) 건너뜀

    const targetM = rowHtml.match(TARGET_RE);
    let opinion = "";
    let analyst = "";
    let source = "";
    let targetPrice = null;
    if (targetM) {
      const n = Number(targetM[1].replace(/,/g, ""));
      targetPrice = Number.isFinite(n) && n > 0 ? n : null;
      const rest = rowHtml.slice(targetM.index + targetM[0].length);
      const cells = [...rest.matchAll(/<td[^>]*>\s*([^<]*?)\s*<\/td>/g)].slice(0, 3).map((m) => stripHtml(m[1]));
      [opinion, analyst, source] = cells.map((c) => c ?? "");
      opinion = parseOpinion(opinion);
    }
    const sourceName = source;

    items.push({
      id: reportIdx,
      date: dateM[1],
      title,
      stockName: tm[1].trim(),
      symbolHint: tm[2],
      opinion,
      targetPrice,
      analyst,
      source: sourceName,
      pdfUrl: `https://consensus.hankyung.com/analysis/downpdf?report_idx=${reportIdx}`,
      category: "기업",
    });
  }
  return items;
}

// 산업분석/투자전략 리포트(2026-09 추가, 오너 지시 — "산업분석/투자전략" 탭
// 준비, 수집기부터 구축). 사이트 분류선택 드롭다운을 확인해 발견한 값:
// report_type=IN("산업"), MA("시장") — 둘 다 "종목명(코드)" 제목 패턴이 아니라
// parseItems 의 STOCK_TITLE_RE 에 안 걸려 지금까지 통째로 버려지고 있었다.
// 이 두 분류는 적정가격 컬럼이 아예 없고(특정 종목 얘기가 아니므로) 컬럼
// 순서가 작성일/제목/투자의견/작성자/제공출처로 하나 앞당겨진다. 제목이
// "[업종명] 헤드라인" 형식이면 대괄호를 업종명(stockName 자리)으로 뽑고,
// 아니면 분류 라벨("산업"/"시장")을 그대로 stockName 으로 둔다. symbol 은
// 항상 null(라우트가 category:"산업" 이면 이름 검색을 아예 건너뜀).
const INDUSTRY_REPORT_TYPES = [
  { code: "IN", label: "산업" },
  { code: "MA", label: "시장" },
];
const BRACKET_RE = /^\[([^\]]+)\]\s*(.*)$/;

// IN/MA(산업/시장) 항목의 국내·해외 구분(2026-09 추가, 오너 지적 — "TSMC와
// 주요 AI 서버 ODM 업체들..." 리포트가 국내로 잘못 남아있는데?"). 이 스크립트는
// "기업" 분류(CO)를 뺀 IN/MA 항목엔 지금까지 market 필드를 아예 안 보내 라우트
// 기본값("kr")으로만 저장돼 있었다 — TSMC/대만/ECB/Fed 얘기까지 전부 국내로
// 잡히는 문제가 실측됨. 제목만으로는 신호가 없는 경우가 많아(예: "AI 수요와
// 고도화, 두 축 모두 견조"는 본문에서야 "TSMC"·"대만"이 나옴) PDF 발췌
// 완료 후 본문까지 포함해 분류한다. 미국뿐 아니라 중국·대만·일본·유럽 등
// 이 사이트 특유의 "해외" 전반을 폭넓게 잡는다(미래에셋 등 다른 해외
// 산업분석 수집기가 US_HINT_RE로 "미국"만 좁게 보는 것과 다른 이유 — 이
// 게시판은 처음부터 특정 국가 전용 게시판이 아니라 국내·해외가 뒤섞인
// "산업/시장" 전체 피드라 국내 신호가 없으면 해외로 본다). 완벽하진 않음
// (국가 신호가 전혀 없는 애매한 글로벌 매크로 코멘트는 kr 기본값으로 남을
// 수 있음) — 다른 산업분석 수집기와 동일한 트레이드오프.
const OVERSEAS_HINT_RE =
  /미국|글로벌|Global|해외|\bUS\b|나스닥|Nasdaq|다우|S&P|연준|\bFed\b|\bECB\b|FOMC|중국|대만|TSMC|일본|유럽|홍콩|베트남|인도|위안화|엔화|유로/i;
function classifyIndustryMarket(hay) {
  return OVERSEAS_HINT_RE.test(hay) ? "us" : "kr";
}

function parseIndustryItems(html, label, reportCode) {
  const items = [];
  for (const rowHtml of html.split(/<tr[^>]*>/).slice(1)) {
    const dateM = rowHtml.match(DATE_RE);
    const titleM = rowHtml.match(TITLE_RE);
    if (!dateM || !titleM) continue;
    const [, reportIdx, rawTitle] = titleM;
    const title = stripHtml(rawTitle);
    // 행 전체에서 단순 텍스트 <td>만 순서대로 매칭 — 중첩 태그가 있는 셀
    // (제목의 팝업 레이어, 차트·첨부파일 링크)은 [^<]* 패턴에 안 걸려 자연히
    // 건너뛰어지므로 [작성일, (투자의견,) 작성자, 제공출처] 순서로만 잡힌다.
    // ⚠️ IN(산업)은 헤더에 "투자의견" 칸이 있어 4칸[작성일/투자의견/작성자/
    // 제공출처]인데, MA(시장)는 그 칸이 아예 없어 3칸[작성일/작성자/제공출처]
    // 이다(실측 확인) — 하나로 취급하면 MA 항목의 작성자·제공출처가 밀려서
    // 뒤바뀐다(실제로 배포된 채 발견한 버그).
    const cells = [...rowHtml.matchAll(/<td[^>]*>\s*([^<]*?)\s*<\/td>/g)].map((m) => stripHtml(m[1]));
    const [analyst, source] = reportCode === "MA" ? [cells[1] ?? "", cells[2] ?? ""] : [cells[2] ?? "", cells[3] ?? ""];
    const bm = title.match(BRACKET_RE);
    // 대괄호가 없는 제목만 종목명 매칭을 시도한다 — 있으면 이미 업종 태그가
    // 의도적으로 붙은 것이므로(예: "[화장품] ...") 그대로 산업분석으로 둔다.
    const stockHit = bm ? null : resolveKrStock(title);
    if (stockHit) {
      // 종목명 뒤에 붙은 조사(의/은/는 등, resolveKrStock 매칭 때 이미 확인된
      // 경계)도 잘라내야 "의 엔진 증설 발표..." 처럼 조사만 남지 않는다.
      let restTitle = title.slice(stockHit.stockName.length);
      const particle = KR_PARTICLES.find((p) => restTitle.startsWith(p));
      if (particle) restTitle = restTitle.slice(particle.length);
      restTitle = restTitle.replace(/^[\s\-–—:,]+/, "").trim();
      items.push({
        id: reportIdx,
        date: dateM[1],
        title: restTitle || title,
        stockName: stockHit.stockName,
        symbolHint: stockHit.symbol,
        opinion: "",
        targetPrice: null,
        analyst,
        source,
        pdfUrl: `https://consensus.hankyung.com/analysis/downpdf?report_idx=${reportIdx}`,
        category: "기업",
      });
      continue;
    }
    const sector = bm ? bm[1].trim() : label;
    const restTitle = bm && bm[2].trim() ? bm[2].trim() : title;

    items.push({
      id: reportIdx,
      date: dateM[1],
      title: restTitle,
      stockName: sector,
      symbolHint: null,
      opinion: "",
      targetPrice: null,
      analyst,
      source,
      pdfUrl: `https://consensus.hankyung.com/analysis/downpdf?report_idx=${reportIdx}`,
      category: "산업",
    });
  }
  return items;
}

const EXCERPT_LEN = 150;
function hangulRatio(l) {
  const h = (l.match(/[가-힣]/g) || []).length;
  return l.length ? h / l.length : 0;
}
function excerptFromPdfText(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const prose = lines.filter((l) => l.length >= 20 && hangulRatio(l) >= 0.4);
  const flat = prose.join(" ").replace(/\s{2,}/g, " ").trim();
  if (!flat) return "";
  if (flat.length <= EXCERPT_LEN) return flat;
  const cut = flat.slice(0, EXCERPT_LEN);
  const boundary = Math.max(cut.lastIndexOf("다."), cut.lastIndexOf("요."), cut.lastIndexOf("함."));
  return (boundary > EXCERPT_LEN * 0.5 ? cut.slice(0, boundary + 1) : cut) + "…";
}
// 목록의 "적정가격" 컬럼이 0/공백인 경우(브로커가 그 값을 안 채웠거나, 목표가
// 대신 "적정주가" 같은 자기들만의 표현을 써서 한경 쪽 정형 컬럼에 안 잡힌
// 경우 — 메리츠증권 실측) PDF 본문에서 라벨을 폭넓게 잡아 폴백으로 뽑는다.
function extractTargetPriceFallback(text) {
  const m = text.match(
    /(?:목표주가|목표가|적정주가|적정가격|TP)(?:를|는|가)?\s*(?:\([^)]{0,10}\))?\s*[:：]?\s*([\d,]+)\s*(만)?\s*원/,
  );
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, "")) * (m[2] ? 10000 : 1);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// 목록의 "적정가격"·"투자의견" 컬럼도 KB증권의 tp/recomm처럼 리포트 본문과
// 무관하게 채워진 값일 위험이 있어(오너 지적, 2026-09 — 모든 소스에 공통
// 적용하기로 함), 본문에 실제 언급이 있는 경우에만 쓰기로 한다.
function mentionsTargetPrice(text) {
  return /목표주가|목표가|적정주가|적정가격|\bTP\b/.test(text);
}
function mentionsOpinion(text) {
  return /투자의견/.test(text);
}

async function extractPdfExcerpt(pdfUrl) {
  try {
    const res = await fetch(pdfUrl, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const parser = new PDFParse({ data: buf });
    const { text } = await parser.getText();
    await parser.destroy();
    return {
      summary: excerptFromPdfText(text),
      targetPriceFallback: extractTargetPriceFallback(text),
      hasTargetMention: mentionsTargetPrice(text),
      hasOpinionMention: mentionsOpinion(text),
    };
  } catch (err) {
    console.warn(`  ⚠ PDF 본문 추출 실패 (${pdfUrl}): ${err.message}`);
    return { summary: "", targetPriceFallback: null, hasTargetMention: false, hasOpinionMention: false };
  }
}

console.log(`▶ 한경 컨센서스 리포트 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지`);
const now = new Date();
const sdate = ymd(new Date(now.getTime() - DAYS * 86_400_000));
const edate = ymd(now);
const collected = [];
for (let page = 1; page <= MAX_PAGES; page++) {
  const html = await fetchPage(page, sdate, edate);
  const items = parseItems(html);
  if (items.length === 0) break;
  collected.push(...items);
  await sleep(400);
}

for (const { code, label } of INDUSTRY_REPORT_TYPES) {
  for (let page = 1; page <= MAX_PAGES; page++) {
    const html = await fetchPage(page, sdate, edate, code);
    const items = parseIndustryItems(html, label, code);
    if (items.length === 0) break;
    collected.push(...items);
    await sleep(400);
  }
}

if (collected.length === 0) {
  console.error("✗ 파싱 결과 0건. 페이지 구조가 바뀌었을 수 있음.");
  process.exit(1);
}
console.log(`✔ 파싱 완료: ${collected.length}건`);
console.log(
  "  최근 5건:",
  collected.slice(0, 5).map((i) => `${i.date} ${i.stockName}(${i.symbolHint}) [${i.source}] — ${i.title}`),
);

console.log(`▶ PDF 본문 발췌 중 (${collected.length}건)...`);
let excerptFailCount = 0;
for (const it of collected) {
  const { summary, targetPriceFallback, hasTargetMention, hasOpinionMention } = await extractPdfExcerpt(it.pdfUrl);
  it.summary = summary;
  // 산업/시장 분류는 특정 종목 얘기가 아니라 목표주가·투자의견 개념 자체가
  // 없음 — PDF에 우연히 등장하는 숫자를 목표주가로 잘못 채우지 않게 건너뜀.
  if (it.category !== "산업") {
    if (it.targetPrice == null) it.targetPrice = targetPriceFallback;
    if (it.targetPrice != null && !hasTargetMention) it.targetPrice = null; // 표 값이 본문에 없으면 버림
    if (it.opinion && !hasOpinionMention) it.opinion = "";
    it.market = "kr"; // "기업" 분류는 "종목명(코드)" 제목 패턴상 항상 국내 상장 종목
  } else {
    it.market = classifyIndustryMarket(`${it.stockName} ${it.title} ${it.summary}`);
  }
  if (!it.summary) excerptFailCount++;
  await sleep(400);
}
console.log(`✔ 발췌 완료 (실패 ${excerptFailCount}건)`);
console.log("  예시:", collected[0]?.summary || "(없음)");

if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;

// /api/cron/shinhan-research 는 body 최상위 하나의 source만 받아 그 안의 모든
// items에 적용한다. 이 스크립트는 항목마다 작성 증권사(제공출처)가 달라서,
// 실제 출처가 정확히 표시되도록(예: "iM증권") 증권사별로 그룹핑해 나눠 보낸다.
// _id 충돌 방지를 위해 접두어를 "한경:" 로 네임스페이스(원 증권사 스크립트의
// _id 체계와 겹치지 않게).
// 자체 수집기가 사이트 전체를 훨씬 넓게 긁는 증권사는 여기서 뺀다 — 한경은
// 선별 게재라 커버리지가 좁다(실측 2026-09: 상상인 한경 90일 12건 vs 자체
// 수집기 126건). 오너 지시로 상상인 제외.
const SKIP_SOURCES = new Set(["상상인증권"]);

// 자체 수집기가 훨씬 많이 가져오는 증권사는 여기서 뺀다 — 상상인증권은 한경
// 경유 90일 12건인데 자사 API 로는 같은 기간 126건(전체 4,466건)이다(오너 지시).
const EXCLUDED_SOURCES = new Set(["상상인증권"]);

// 라우트는 POST 한 번당 market 하나만 받으므로(전체 items에 일괄 적용),
// source뿐 아니라 market까지 묶어서 그룹핑한다 — 같은 증권사라도 "산업"
// 분류 결과가 국내/해외로 갈릴 수 있어(2026-09 추가) source만으로 묶으면
// 안 됨.
const bySourceMarket = new Map();
for (const it of collected) {
  if (EXCLUDED_SOURCES.has((it.source || "").trim())) continue;
  const source = it.source || "한경컨센서스";
  if (SKIP_SOURCES.has(source)) continue;
  const market = it.market || "kr";
  const key = `${source}|${market}`;
  if (!bySourceMarket.has(key)) bySourceMarket.set(key, { source, market, items: [] });
  bySourceMarket.get(key).items.push({
    id: `한경:${it.id}`,
    date: it.date,
    title: it.title,
    stockName: it.stockName,
    symbol: it.symbolHint,
    analyst: it.analyst,
    opinion: it.opinion,
    targetPrice: it.targetPrice,
    summary: it.summary,
    pdfUrl: it.pdfUrl,
    views: null,
    category: it.category,
  });
}

let totalUpserted = 0;
for (const { source, market, items: group } of bySourceMarket.values()) {
  const up = await fetch(IMPORT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ items: group, source, market }),
  });
  const upBody = await up.text();
  if (!up.ok) {
    console.error(`✗ [${source}/${market}] 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 200)}`);
    continue;
  }
  console.log(`✔ [${source}/${market}] ${group.length}건 전송: ${upBody}`);
  totalUpserted += group.length;
}
console.log(`\n✔ 총 ${totalUpserted}건 전송 완료 (${bySourceMarket.size}개 그룹)`);
