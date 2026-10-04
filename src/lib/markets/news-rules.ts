/**
 * 종목뉴스 관련성 규칙 — 코드만, 비용 0(오너 지시 2026-10-03: 종목뉴스에 Claude/에이전트 금지, 코드가 먼저·필요 시 Gemini).
 *
 * 2026-10-04 기준 세트(6종목·547건, 사람이 정답 표시)로 재서 만든 규칙이다. 판단 근거는 **제목**만 쓴다 —
 * 요약에만 회사명이 나오는 기사는 거의 전부 다른 주제(부동산·생활·다른 회사)였다(기준 세트 실측).
 *
 * | 판정                         | 국내 정밀도 | 국내 재현율 | 해외 정밀도 | 해외 재현율 |
 * |------------------------------|-------------|-------------|-------------|-------------|
 * | 10-03 규칙(태깅 신뢰·요약 허용) | 31%         | 99%         | 80%         | 99%         |
 * | 옛 Claude 판정                | 57%         | 69%         | 92%         | 50%         |
 * | 이 규칙                       | 97%         | 86%         | 91%         | 99%         |
 * | 이 규칙 — 처음 보는 4종목(399건, SK하이닉스·LS일렉트릭·MSFT·TSLA) | 84% | 88% | 98% | 99% |
 *
 * 첫 줄들은 규칙을 맞춘 표본이라 낙관적이다. 마지막 줄은 다른 종목 표본인데, 거기서 드러난 일반적인 구멍(영문 약자 회사명·판촉·나열·
 * 관사 용법)도 보강했으므로 완전한 독립 측정은 아니다. 처음 보는 표본의 보강 전 값은 국내 73%·69%, 해외 85%·98% 였다.
 * 정규식은 이 파일에만 둔다(셸·템플릿 문자열을 거치며 `\s` 가 `s` 로 깨진 일이 있었다 — 10-03 ROUNDUP_RE).
 */

const HANGUL = /[가-힣]/;
/** 이름 뒤에 붙어도 같은 낱말로 보는 조사·접미 */
const PARTICLE = /^(은|는|이|가|을|를|의|도|와|과|에|로|으로|만|까지|부터|이나|나|측|株|주)/;

/**
 * DART 정식명이 영문 약자를 한글로 적은 경우("엘에스일렉트릭", "에스케이하이닉스") 기사 제목 표기("LS일렉트릭")로 바꾼 이름.
 * 2026-10-04 처음 보는 종목 표본에서 LS일렉트릭 국내 기사 7건을 전부 놓친 원인. 바꿀 게 없으면 null.
 */
const KO_ACRONYMS: [string, string][] = [
  ["에이치디", "HD"], ["에스케이", "SK"], ["엘에스", "LS"], ["엘지", "LG"], ["케이티앤지", "KT&G"], ["케이티", "KT"],
  ["지에스", "GS"], ["씨제이", "CJ"], ["에스디", "SD"], ["케이씨씨", "KCC"], ["디비", "DB"], ["비에이치", "BH"], ["에이치엘", "HL"],
];
export function koAcronymName(name: string): string | null {
  let out = name;
  for (const [ko, en] of KO_ACRONYMS) if (out.startsWith(ko)) out = en + out.slice(ko.length);
  return out === name ? null : out;
}

/** 한국어 제목에서 낱말 경계까지 확인한 이름 찾기 — "애플망고"·"오웬스코닝"·"코닝정밀소재" 같은 부분일치를 막는다 */
export function koTitleHit(text: string, word: string): boolean {
  if (!word) return false;
  let from = 0;
  for (;;) {
    const i = text.indexOf(word, from);
    if (i < 0) return false;
    const before = text[i - 1] ?? "";
    const after = text.slice(i + word.length);
    if (!HANGUL.test(before) && (!HANGUL.test(after[0] ?? "") || PARTICLE.test(after))) return true;
    from = i + 1;
  }
}

/** 한국 종목 — 회사명 외에 기사 제목에 자주 쓰는 통칭·대표 제품(그룹 통칭 "삼성"처럼 계열사 구분이 안 되는 말은 넣지 않는다) */
export const KR_COMPANY_ALIASES: Record<string, string[]> = {
  삼성전자: ["삼성전자", "삼전", "삼전닉스", "삼전·닉스", "갤럭시"],
  SK하이닉스: ["SK하이닉스", "하이닉스", "삼전닉스", "삼전·닉스"],
  LG전자: ["LG전자"],
  LG에너지솔루션: ["LG에너지솔루션", "LG엔솔"],
  현대차: ["현대차", "현대자동차"],
  현대자동차: ["현대차", "현대자동차"],
  기아: ["기아", "기아차"],
  삼성바이오로직스: ["삼성바이오로직스", "삼성바이오"],
  삼성SDI: ["삼성SDI"],
  NAVER: ["네이버", "NAVER"],
  카카오: ["카카오"],
  셀트리온: ["셀트리온"],
  POSCO홀딩스: ["포스코홀딩스", "POSCO홀딩스"],
  한화에어로스페이스: ["한화에어로스페이스", "한화에어로", "천무", "레드백", "K9"],
  현대로템: ["현대로템", "로템", "K2 전차", "K2전차"],
};

/** 그룹 통칭만으로는 계열사 구분이 안 되는 경우 — 업종 맥락 단어가 같은 제목에 있을 때만 그 회사로 본다 */
export const KR_CONTEXT_ALIASES: Record<string, { alias: string; context: RegExp }> = {
  한화에어로스페이스: { alias: "한화", context: /방산|미사일|유도탄|추진기관|발사체|자주포|전투기|KF-21|K9|천무|레드백/ },
};

/** 미국 종목 한글명 → 국내 기사 제목에 자주 나오는 대표 제품 */
export const KO_PRODUCT_ALIASES: Record<string, string[]> = {
  애플: ["아이폰", "맥북", "에어팟", "애플워치"],
};

/** 경쟁 제품을 나란히 적은 업계 기사("아이폰·갤럭시 가격") — 특정 회사 얘기가 아니다 */
const RIVAL_PAIR = /(아이폰|애플)\s?[·,]\s?(갤럭시|삼성)|(갤럭시|삼성)\s?[·,]\s?(아이폰|애플)|애플\s?제친|제친\s?갤럭시/;

/** 시황·마감·나열 기사 */
const ROUNDUP_KO =
  /특징주|강세\s?종목|약세\s?종목|급등주|급락주|상한가|하한가|마감\s?시황|장\s?마감|뉴욕\s?(증시|마감)|美\s?증시|증시\s?(브리핑|요약|마감|출발)|마켓\s?(브리핑|펄스)|오늘의\s?(증시|종목)|코스[피닥]\s?(마감|출발)|순매수\s?(상위|종목)|일제히\s?(상승|하락)|3대\s?지수/;
const ROUNDUP_EN =
  /\b(top|biggest)\s+(gainers|losers|movers)\b|stocks?\s+to\s+watch|stock market today|market wrap|(premarket|midday|after-hours)\s+movers|stocks making the biggest moves|dow jones futures|stock futures (rise|fall|edge)|\broundup\b|market talk|top analyst calls/i;

/** 이름 바로 뒤가 "…다음 타자·…보다 더·…만 볼 때" — 그 회사가 아니라 다른 종목 얘기 */
const NOT_ABOUT_KO = /(다음\s?타자|다음엔|보다\s?더|말고|만\s?볼\s?때|아닌|대신)/;

/** 같은 낱말을 쓰는 다른 대상(과일 사과·다른 회사·지명) — 소문자 이름 낱말 기준 */
const HOMONYM_EXCLUDE: Record<string, RegExp> = {
  apple: /\bapples?\b\s*(picking|pie|cider|orchard|varieties|fest|season)|picking|orchard|cider|blood sugar|states that produce/i,
  corning: /owens corning|corning,\s*n\.?y|city of corning|corning city/i,
};

export interface Verdict {
  keep: boolean;
  reason: string;
}

/** 국내(한국어) 기사 판정 — names: 회사명·통칭·제품명, context: 그룹 통칭 조건부 별칭 */
export function judgeDomesticTitle(
  title: string,
  names: string[],
  context?: { alias: string; context: RegExp } | null,
): Verdict {
  let hit = names.find((n) => koTitleHit(title, n));
  if (!hit && context && koTitleHit(title, context.alias) && context.context.test(title)) hit = context.alias;
  if (!hit) return { keep: false, reason: "제목에 회사명 없음" };
  if (RIVAL_PAIR.test(title)) return { keep: false, reason: "경쟁 제품 나란히(업계 기사)" };
  if (ROUNDUP_KO.test(title)) return { keep: false, reason: "시황·마감 기사" };
  const pos = title.indexOf(hit);
  const at = pos + hit.length;
  if (NOT_ABOUT_KO.test(title.slice(at, at + 12))) return { keep: false, reason: "다른 종목 얘기(…다음·…보다)" };
  // "제2의 테슬라" — 그 회사가 아니라 비유
  if (/제\s?2의\s?$/.test(title.slice(Math.max(0, pos - 5), pos))) return { keep: false, reason: "비유(제2의 …)" };
  return { keep: true, reason: `제목에 ${hit}` };
}

const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 영문 제목에서 이름 찾기 — 낱말 경계. 티커는 대소문자 구분("BE"가 영어 "be"에 걸리지 않게), 회사명은 구분 안 함(EDGAR 명은 전부 대문자) */
export function enTitleHit(text: string, word: string, caseSensitive = false): boolean {
  if (!word) return false;
  if (new RegExp(`(^|[^A-Za-z0-9])${esc(word)}(?![A-Za-z0-9])`, caseSensitive ? "" : "i").test(text)) return true;
  // EDGAR 명 "COCA COLA"·"MCDONALDS"·"AMAZON COM" 은 제목의 "Coca-Cola"·"McDonald's"·"Amazon.com" 과 낱말로는 안 맞는다(2026-09 실측) —
  // 구두점·공백을 지우고 비교한다. 짧은 이름은 다른 낱말 속에 섞이기 쉬워("apple"→"pineapple") 6자 이상만.
  const w = squash(word);
  return !caseSensitive && w.length >= 6 && squash(text).includes(w);
}
const squash = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");

/** 해외(영문) 기사 판정 — names: 정리된 회사명·고유한 첫 낱말, ticker: 티커(대소문자 구분) */
export function judgeOverseasTitle(title: string, names: string[], ticker?: string | null): Verdict {
  const hit = names.find((n) => enTitleHit(title, n)) ?? (ticker && enTitleHit(title, ticker, true) ? ticker : undefined);
  if (!hit) return { keep: false, reason: "제목에 회사명 없음" };
  for (const n of names) {
    const ex = HOMONYM_EXCLUDE[n.toLowerCase()];
    if (ex && ex.test(title)) return { keep: false, reason: "같은 낱말 다른 대상(과일·지명·다른 회사)" };
  }
  const h = esc(hit);
  // 시황 기사라도 "Stock Market Today, Oct. 2: Tesla Rises on …" 처럼 콜론 뒤 주어가 그 회사면 그 회사 기사다
  if (ROUNDUP_EN.test(title) && !new RegExp(`:\\s*${h}\\b`, "i").test(title)) return { keep: false, reason: "시황·나열 기사" };
  // "Not Nvidia"·"Not Samsung or SK Hynix"·"Forget Microsoft"·"beyond SK hynix"·"Vying With Tesla" — 그 회사가 아니라 다른 대상 얘기
  if (new RegExp(`\\b(not|forget|beyond|vying with|replacement for)\\s+(?:[\\w&.'-]+\\s+){0,2}(?:or\\s+)?${h}\\b`, "i").test(title))
    return { keep: false, reason: "부정·비교 대상(Not·Forget …)" };
  // 할인·판촉·협찬("deal slashes", "for just $40", "with this $50 Microsoft tool", "Powered by Microsoft Surface")
  if (/\bdeals?\b.*\bfrom\b|\bbest\b.*\bdeals\b|deal slashes|lifetime access|for just \$|with this \$\d|\bpowered by\b/i.test(title))
    return { keep: false, reason: "할인·판촉·협찬" };
  // "for a new Tesla"·"in a Tesla Model S"·"a Microsoft engineer" — 회사가 아니라 차·사람을 가리키는 관사 용법.
  // "a Microsoft stock split"·"a Microsoft bug" 는 회사 기사라 뒤 낱말로 가른다(처음 보는 표본 실측).
  if (new RegExp(`\\b(a|an)\\s+(new\\s+)?${h}(\\s+(model|engineer|employee|owner|driver|fan|user)\\b|\\s*[—–-]|\\s*$)`, "i").test(title))
    return { keep: false, reason: "관사 용법(a Tesla 등)" };
  // "Coherent Jumps 10%…; Lumentum Rises 9%, Corning Advances 3%" — 등락률 여러 개 + 회사가 맨 앞이 아님
  const at = title.search(new RegExp(h, "i"));
  const pcts = (title.match(/\d+(\.\d+)?%/g) ?? []).length;
  if (pcts >= 2 && at > 0) return { keep: false, reason: "여러 종목 등락 나열" };
  // "Micron Slips 3% …; Western Digital Dips, SK Hynix Drifts" — 세미콜론 뒤 덧붙은 다른 종목들
  const semi = title.indexOf(";");
  if (semi >= 0 && at > semi) return { keep: false, reason: "여러 종목 등락 나열" };
  // "Nvidia, Tesla, Rivian, On Semi, …"·"I Sold NVIDIA, Google and Microsoft" — 쉼표로 3개 이상 나열된 이름 중 하나
  const list = title.match(/(?:[A-Z][\w&.'-]*(?:\s[A-Z][\w&.'-]*)?,\s+){2,}(?:and\s+)?[A-Z][\w&.'-]*|[A-Z][\w&.'-]*,\s+[A-Z][\w&.'-]*,?\s+and\s+[A-Z][\w&.'-]*/);
  if (list && new RegExp(h, "i").test(list[0])) return { keep: false, reason: "여러 종목 나열" };
  return { keep: true, reason: `제목에 ${hit}` };
}
