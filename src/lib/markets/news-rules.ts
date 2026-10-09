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
 *
 * 2026-10-05 미국 종목(AMAT 국내뉴스 3건 지적) — 국내 검색 질의를 한글명·한글 약칭·티커로 늘리고 약칭·티커만 있는 제목은 요약으로 확인,
 * 영문 첫 낱말은 대문자·다른 상장사 이름(네이버 자동완성) 구분. 미국 8종목(AMAT·MU·LRCX·MRVL·BE·DAL·WDC·ISRG) 같은 시각 수집, 제목 기준 정답:
 *   국내 정답 106건: 수정 전 남김 4건(정밀도 100%·재현율 4%) → 수정 후 117건(85%·93%)
 *   해외 정답 255건: 수정 전 341건(74%·98%) → 수정 후 278건(90%·98%)
 *   한국 7종목은 같은 원본에서 기사 단위로 판정이 전부 같다(회귀 없음).
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

/** 일본 종목 한글 약칭이 사람 이름인 스포츠 기사("소니" = 손흥민 별명, "타케다" = SSG 투수) — 약칭으로만 걸렸을 때 뺀다(2026-10-10 6758·4502 표본) */
export const JP_ALIAS_SPORTS_RE = /손흥민|토트넘|LAFC|A매치|\d+호\s?골|대표팀|KBO|NPB|SSG|1군|말소|선발\s?투수|투수|타자|홈런|이적/;

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

/**
 * 미국 종목 약칭(회사명 첫 낱말 — "어플라이드"·"Applied")과 그 약칭으로 시작하는 다른 상장사 이름(네이버 자동완성 — "어플라이드 디지털"·
 * "Applied Optoelectronics").  2026-10-05 오너 지적(AMAT 국내뉴스 3건): 기사 제목은 "어플라이드·베시 …"처럼 약칭을 쓰는데 약칭을 인정하지
 * 않아 놓쳤고, 반대로 해외 쪽은 첫 낱말을 대소문자 구분 없이 인정해 "Applied Digital"·"penalties applied"(F1) 기사가 들어왔다.
 */
export interface ShortAlias {
  /** 약칭 — 회사명 첫 낱말 */
  alias: string;
  /** 회사명에서 약칭 다음 낱말("머티어리얼즈"·"Materials") — 붙여 쓰거나 표기가 조금 달라도("머티리얼즈") 자기 이름으로 본다 */
  next?: string | null;
  /** 같은 약칭으로 시작하는 다른 종목의 전체 이름 */
  rivals: string[];
}

/** 약칭 바로 뒤가 다른 종목 이름의 다음 낱말인지 — 낱말 앞 2글자(한글)·4글자(영문)로 비교해 붙여쓰기·표기 차이를 견딘다 */
function stemOf(word: string): string {
  const w = word.trim();
  return /^[가-힣]/.test(w) ? w.slice(0, 2) : w.slice(0, 4);
}
function startsWithStem(rest: string, word: string | null | undefined): boolean {
  if (!word) return false;
  const s = stemOf(word);
  return s.length > 0 && rest.toLowerCase().startsWith(s.toLowerCase());
}
function rivalNextWords(a: ShortAlias): string[] {
  const own = a.next ? stemOf(a.next).toLowerCase() : null;
  const out: string[] = [];
  for (const r of a.rivals) {
    if (!r.toLowerCase().startsWith(a.alias.toLowerCase())) continue;
    const next = r.slice(a.alias.length).trim().split(/\s+/)[0] ?? "";
    // 약칭과 이름이 똑같은 종목("어플라이드" 일본 상장사)·같은 회사의 다른 시장 상장(홍콩 "어플라이드 머티어리얼즈")은 구분 근거가 아니다
    if (!next || (own && stemOf(next).toLowerCase() === own)) continue;
    out.push(next);
  }
  return out;
}

/**
 * 제목에서 약칭이 이 회사를 가리키는 자리가 있는지. 한글은 낱말 경계(조사 허용) 또는 바로 뒤가 자기 이름 다음 낱말("어플라이드머티리얼즈"),
 * 영문은 낱말 경계 + 첫 글자 대문자(일반 낱말 "applied" 제외). 어느 쪽이든 바로 뒤(공백 허용)가 다른 종목 이름의 다음 낱말이면 그 자리는 버린다.
 */
export function shortAliasHit(text: string, a: ShortAlias): boolean {
  const ko = HANGUL.test(a.alias);
  const rivals = rivalNextWords(a);
  const lower = text.toLowerCase();
  const alias = a.alias.toLowerCase();
  let from = 0;
  for (;;) {
    const i = ko ? text.indexOf(a.alias, from) : lower.indexOf(alias, from);
    if (i < 0) return false;
    from = i + 1;
    const before = text[i - 1] ?? "";
    const after = text.slice(i + a.alias.length);
    const rest = after.replace(/^\s+/, "");
    if (ko) {
      if (HANGUL.test(before)) continue;
      const bounded = !HANGUL.test(after[0] ?? "") || PARTICLE.test(after) || startsWithStem(after, a.next);
      if (!bounded) continue;
    } else {
      if (/[A-Za-z0-9]/.test(before) || /^[A-Za-z0-9]/.test(after)) continue;
      if (!/[A-Z]/.test(text[i])) continue;
    }
    if (rivals.some((w) => startsWithStem(rest, w))) continue;
    return true;
  }
}

/** 국내(한국어) 기사 판정 — names: 회사명·통칭·제품명, context: 그룹 통칭 조건부 별칭 */
export function judgeDomesticTitle(
  title: string,
  names: string[],
  context?: { alias: string; context: RegExp } | null,
  short?: ShortAlias | null,
): Verdict {
  let hit = names.find((n) => koTitleHit(title, n));
  if (!hit && context && koTitleHit(title, context.alias) && context.context.test(title)) hit = context.alias;
  if (!hit && short && shortAliasHit(title, short)) hit = short.alias;
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

/**
 * 해외(영문) 기사 판정 — names: 정리된 회사명, ticker: 티커(대소문자 구분), short: 고유한 첫 낱말(대문자로 시작할 때만, 같은 낱말로 시작하는
 * 다른 상장사 이름이 이어지면 제외 — 2026-10-05 "Applied Digital"·"penalties applied" 가 AMAT 기사로 들어오던 문제)
 */
export function judgeOverseasTitle(title: string, names: string[], ticker?: string | null, short?: ShortAlias | null): Verdict {
  const hit =
    names.find((n) => enTitleHit(title, n)) ??
    (ticker && enTitleHit(title, ticker, true) ? ticker : undefined) ??
    (short && shortAliasHit(title, short) ? short.alias : undefined);
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
