/**
 * 업종 라벨 보정 공통 lib — 업종 리포트인데 수집기가 업종명을 못 뽑아 기본값("산업")을 붙인 항목의
 * 라벨을 실제 업종명으로 바꾼다(오너 지시 2026-09-26 — 유안타 자동차 리포트 "분기중 환율 자유낙하 -
 * 실적에는 조삼모사"가 라벨 "산업" + 제목의 "환율" 때문에 환율분석으로 분류된 사례. "업종리포트를
 * 잘못 분류하지 않기 위해 반드시 필요"). 앱 분류 함수는 라벨이 업종명이면 산업분석으로 두고, 라벨이
 * 뭉뚱그린 값이면 제목 키워드(환율·금리·Daily 등)로 분류해 버린다 — 그래서 라벨이 정확해야 한다.
 *
 * 우선순위: ① 제목 앞머리 "업종; 헤드라인"·"[업종] 헤드라인" ② 제목 안의 업종 단어 ③ PDF 첫 부분(표지)의
 * 업종 단어. 세 곳에서 못 찾으면 라벨을 바꾸지 않는다(애매한 걸 지어내지 않음).
 */
import { readPdfText } from "./research-extract.mjs";

// 대신증권 "Industry Report"처럼 시리즈 이름이 업종 자리에 라벨로 온 경우도 뭉뚱그린 라벨로 본다(오너 지적 2026-09-27).
export const GENERIC_SECTOR_LABELS = /^(산업|산업분석|Industry\s*Report|Sector\s*Report)$/i; // "시장"은 시장 코멘트라 대상 아님

// 업종 어휘 — 긴 이름 먼저(부분 일치 방지). [정규식, 표준 라벨]
const VOCAB = [
  [/2차\s*전지|배터리|이차전지/, "2차전지"], [/반도체/, "반도체"], [/디스플레이/, "디스플레이"],
  [/전력\s*기기|변압기|전선/, "전력기기"], [/원전|원자력|SMR/, "원전"], [/유틸리티|전력|가스/, "유틸리티"],
  [/자동차|완성차|자동차부품|타이어/, "자동차"], [/조선|해양플랜트/, "조선"], [/방산|방위|우주항공/, "방산"], [/우주|위성/, "우주항공"],
  [/항공|LCC|공항/, "항공"], [/해운|컨테이너|탱커|벌크/, "해운"], [/운송|물류|택배/, "운송"],
  [/건설|건자재|시멘트/, "건설"], [/철강|금속/, "철강"], [/정유|화학|석유화학/, "정유화학"], [/에너지|신재생|태양광/, "에너지"],
  [/은행|금융지주/, "은행"], [/보험/, "보험"], [/증권|브로커리지/, "증권"], [/카드|캐피탈|여신/, "카드/캐피탈"],
  [/제약|바이오|신약/, "제약/바이오"], [/의료기기|헬스케어|에스테틱/, "의료기기/헬스케어"], [/화장품|뷰티/, "화장품"],
  [/음식료|식품|음료|주류/, "음식료"], [/유통|리테일|백화점|이커머스|편의점/, "유통"], [/호텔|레저|카지노|면세/, "호텔/레저"],
  [/여행/, "여행"], [/통신|5G|무선/, "통신"], [/미디어|광고|방송/, "미디어"], [/엔터테인먼트|엔터|K-?POP/i, "엔터"],
  [/게임/, "게임"], [/인터넷|플랫폼|포털/, "인터넷"], [/소프트웨어|SW|클라우드|사이버보안/, "소프트웨어"],
  [/로보틱스|로봇/, "로보틱스"], [/IT하드웨어|전자부품|스마트폰|PCB|MLCC/, "IT하드웨어"], [/기계|공작기계|건설기계/, "기계"],
  [/지주|지주사/, "지주"], [/교육|출판/, "교육"],
];

function fromVocab(text) {
  let best = null;
  for (const [re, label] of VOCAB) {
    const m = re.exec(text);
    if (m && (best === null || m.index < best.idx)) best = { idx: m.index, label };
  }
  return best?.label ?? null;
}


/** PDF 표지 텍스트 — 1쪽(비어 있으면 2쪽까지) 앞 500자. 페이지 구분자는 pdf-parse 의 "-- N of M --". */
function coverText(pdfText) {
  const pages = String(pdfText ?? "").split(/-- \d+ of \d+ --/);
  const first = (pages[0] ?? "").trim();
  return (first.length >= 30 ? first : `${first}
${pages[1] ?? ""}`).slice(0, 500);
}

/** 문자열이 업종 어휘 하나와 정확히 일치하면(접미어 "업"·"산업" 허용) 그 표준 이름, 아니면 null. */
function singleVocabLabel(text) {
  const stem = String(text ?? "").trim().replace(/(?:산업|업종|업)$/, "").trim();
  for (const [re, canonical] of VOCAB) {
    const m = re.exec(stem);
    if (m && m[0] === stem) return canonical;
  }
  return null;
}

/** 라벨이 이미 업종명(업종 어휘 포함)이면 true — 제목 조각이 라벨로 들어온 경우(예: "소듐이온 전지(SIB) 기대감 확산")를 걸러낸다. */
export function looksLikeSectorLabel(label) {
  return fromVocab(String(label ?? "")) !== null;
}

/** PDF 표지가 IPO(공모) 리포트인지 — "IPO Report"·"공모개요" 표기. 비상장으로 분류할 때 쓴다(오너 지시 2026-09-27). */
export function isIpoCover(pdfText) {
  const cover = coverText(pdfText);
  return /IPO\s*Report|공모\s*개요|수요\s*예측/i.test(cover);
}


/**
 * 업종 라벨을 표준 이름으로 정규화(오너 지시 2026-09-27 — DS "[대조선]"은 "조선"이다, "업종 어휘는 표준 이름으로 정규화").
 * 서로 다른 세부 업종을 합치지 않고 **표기 변형(동의어)만** 표준 이름으로 맞춘다 — 그래서 명시적 동의어 표를 쓴다
 * (예: 태양광→에너지, 정유·화학→정유화학 같은 상위 통합은 하지 않는다). 접미어("업"·"산업"·"업종")와 한 글자 접두어
 * (대·소·중·신·新)는 허용한다. 표에 없는 라벨(복합 라벨 "정유화학/철강금속/음식료", "비철금속" 등)은 그대로 둔다.
 */
const SECTOR_SYNONYMS = [
  ["조선", ["조선", "조선해양", "조선/해양"]],
  ["2차전지", ["2차전지", "2차 전지", "이차전지", "이차 전지", "배터리"]],
  ["방산", ["방산", "방위산업", "방위 산업", "국방"]],
  ["로보틱스", ["로보틱스", "로봇"]],
  ["엔터", ["엔터", "엔터테인먼트"]],
  ["자동차", ["자동차"]],
  ["반도체", ["반도체"]],
  ["기계", ["기계"]],
  ["철강", ["철강"]],
  ["건설", ["건설"]],
  ["은행", ["은행"]],
  ["보험", ["보험"]],
  ["증권", ["증권"]],
  ["항공", ["항공"]],
  ["해운", ["해운"]],
];
const SYNONYM_TO_CANON = new Map(SECTOR_SYNONYMS.flatMap(([canon, list]) => list.map((w) => [w, canon])));
// 업종 태그 자리에 담당 애널리스트 이름이 온 경우(예: DS "[매태호] …" — 방산 담당) → 그 애널리스트의 업종. 모든 증권사 공통
// (오너 지시 2026-09-27 — "ds말고 다른 회사들도 공통으로 처리"). 새 사례가 확인되면 여기 한 줄 추가(서버 쪽
// `src/lib/research-sector.ts` 의 ANALYST_SECTOR 와 같은 표 — verify-classification.mts 가 일치 검사).
export const ANALYST_SECTOR = { 매태호: "방산" };
export function normalizeSectorLabel(label) {
  const raw = String(label ?? "").trim();
  if (!raw) return raw;
  if (Object.hasOwn(ANALYST_SECTOR, raw)) return ANALYST_SECTOR[raw];
  const stem = raw.replace(/(?:산업|업종|섹터|부문|업)$/, "").trim();
  const candidates = [stem];
  const pre = stem.match(/^[대소중신新]\s?(.+)$/);
  if (pre) candidates.push(pre[1].trim());
  for (const c of candidates) {
    const canon = SYNONYM_TO_CANON.get(c);
    if (canon) return canon;
  }
  return raw;
}

/** 제목·PDF 표지에서 업종 라벨을 뽑는다(못 찾으면 null). pdfText 는 없으면 생략. */
export function sectorFromTitleOrCover(title, pdfText = "") {
  const t = String(title ?? "").trim();
  // ① "업종; 헤드라인" / "[업종] 헤드라인" — 앞머리가 짧고 업종 어휘를 포함하면 앞머리 통째(복합 업종 유지)
  const head = t.match(/^\[([^\]]{1,25})\]/)?.[1] ?? t.match(/^([^;:]{1,25})[;:]/)?.[1];
  // 앞머리가 업종 하나뿐이면 표준 이름으로("제약업" → "제약/바이오"), 복합 라벨("정유화학/철강금속/음식료")은 앞머리 통째로 둔다.
  if (head && fromVocab(head)) return normalizeSectorLabel(head.trim()) !== head.trim() ? normalizeSectorLabel(head.trim()) : singleVocabLabel(head.trim()) ?? head.trim();
  // ② 제목 안의 업종 단어
  const inTitle = fromVocab(t);
  if (inTitle) return inTitle;
  // ③ PDF 표지(첫 페이지 앞 500자)
  const cover = coverText(pdfText);
  return cover ? fromVocab(cover) : null;
}

/**
 * items(수집기가 만든 항목 배열)의 뭉뚱그린 라벨을 제자리에서 보정한다. category 가 "산업"이고
 * symbol 이 없으며 stockName 이 기본값("산업")인 항목만 대상. 제목에서 못 찾으면 PDF 표지를 읽는다.
 * 반환: 바꾼 건수.
 */
export async function refineSectorLabels(items, { sleepMs = 200 } = {}) {
  let changed = 0;
  for (const it of items) {
    if (it.category !== "산업" || it.symbol || !GENERIC_SECTOR_LABELS.test(String(it.stockName ?? "").trim())) continue;
    let label = sectorFromTitleOrCover(it.title);
    if (!label && it.pdfUrl) {
      const text = await readPdfText(it.pdfUrl).catch(() => "");
      label = sectorFromTitleOrCover(it.title, text);
      await new Promise((r) => setTimeout(r, sleepMs));
    }
    if (label) { it.stockName = label; changed++; }
  }
  return changed;
}
