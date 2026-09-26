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

export const GENERIC_SECTOR_LABELS = /^(산업|산업분석)$/; // "시장"은 시장 코멘트라 대상 아님

// 업종 어휘 — 긴 이름 먼저(부분 일치 방지). [정규식, 표준 라벨]
const VOCAB = [
  [/2차\s*전지|배터리|이차전지/, "2차전지"], [/반도체/, "반도체"], [/디스플레이/, "디스플레이"],
  [/전력\s*기기|변압기|전선/, "전력기기"], [/원전|원자력|SMR/, "원전"], [/유틸리티|전력|가스/, "유틸리티"],
  [/자동차|완성차|자동차부품|타이어/, "자동차"], [/조선|해양플랜트/, "조선"], [/방산|방위|우주항공/, "방산"],
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

/** 라벨이 이미 업종명(업종 어휘 포함)이면 true — 제목 조각이 라벨로 들어온 경우(예: "소듐이온 전지(SIB) 기대감 확산")를 걸러낸다. */
export function looksLikeSectorLabel(label) {
  return fromVocab(String(label ?? "")) !== null;
}

/** PDF 표지가 IPO(공모) 리포트인지 — "IPO Report"·"공모개요" 표기. 비상장으로 분류할 때 쓴다(오너 지시 2026-09-27). */
export function isIpoCover(pdfText) {
  const cover = coverText(pdfText);
  return /IPO\s*Report|공모\s*개요|수요\s*예측/i.test(cover);
}

/** 제목·PDF 표지에서 업종 라벨을 뽑는다(못 찾으면 null). pdfText 는 없으면 생략. */
export function sectorFromTitleOrCover(title, pdfText = "") {
  const t = String(title ?? "").trim();
  // ① "업종; 헤드라인" / "[업종] 헤드라인" — 앞머리가 짧고 업종 어휘를 포함하면 앞머리 통째(복합 업종 유지)
  const head = t.match(/^\[([^\]]{1,25})\]/)?.[1] ?? t.match(/^([^;:]{1,25})[;:]/)?.[1];
  if (head && fromVocab(head)) return head.trim();
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
