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
export const JP_ALIAS_SPORTS_RE =
  /손흥민|토트넘|LAFC|A매치|\d+호\s?골|대표팀|KBO|NPB|SSG|[123]군|말소|선발\s?투수|투수|타자|홈런|이적|야구|퓨처스|유망주|교류전|매직\s?넘버|호크스|승패/;

/**
 * 같은 한글 이름을 쓰는 일본 상장사 — 제목의 그 이름이 어느 회사인지 종목별 문맥어로 가른다(오너 지시 2026-10-10 — 9984 소프트뱅크그룹·
 * 9434 소프트뱅크). 제목이 이름만 쓰고(그 이름이 약칭이든 정식명이든) 이 종목 문맥어가 있고 다른 종목 문맥어가 없을 때만 이 종목 기사로 본다.
 * 둘 다 있거나 둘 다 없으면 어느 회사인지 모르는 것이라 뺀다. 프로야구 구단(후쿠오카 소프트뱅크 호크스) 기사는 JP_ALIAS_SPORTS_RE 가 먼저 뺀다.
 * 문맥어는 2026-09-10~10-10 네이버 뉴스 제목("소프트뱅크" 93건)에서 골랐다 — 그룹: 오픈AI 투자·정크본드/채권·CDS·Arm 담보대출·RAI 인수·
 * 손정의·주가 급등락(닛케이 대형주라 국내 기사의 "소프트뱅크 주가"는 그룹)·대출·신용등급, 통신: 공중 통신망(HAPS)·요금·휴대폰·LINE야후·PayPay.
 * 그 93건 판정: 그룹 59·통신 1·야구 20·모름 11(랜섬웨어 피해 자회사·베어로보틱스 판매·합작법인 등 — 어느 회사인지 제목만으로 모름)·
 * "소프트뱅크그룹" 표기 2(정식명으로 9984).
 */
export const JP_SHARED_NAME_CONTEXT: Record<string, Record<string, RegExp>> = {
  소프트뱅크: {
    "9984":
      /손정의|마사요시|비전\s?펀드|SVF|SBG|소프트뱅크\s?그룹|오픈\s?AI|OpenAI|챗GPT|스타게이트|Stargate|\bArm\b|ARM|암\s?(홀딩스|지분|인수)|정크\s?본드|채권|사채|CDS|담보\s?대출|출자|지분|인수|투자|RAI|SBVA|주가|급락|급등|↓|↑|시총|자회사\s?IPO|계열사|대출|무디스|신용\s?등급|강등/,
    "9434": /통신|휴대폰|스마트폰|아이폰|요금|5G|6G|기지국|LINE|라인\s?야후|야후|PayPay|페이페이|와이\s?모바일|Y!mobile|HAPS|성층권|무인기/,
  },
};

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

// ── 일본 종목 일본어 기사(구글 뉴스 일본판) — 오너 결정 2026-10-10 "일본어 주 + 영문은 화이트리스트 매체만" ──────────────

/**
 * 일본 언론 관용 약칭 — 종목코드별(한국 KR_COMPANY_ALIASES 와 같은 성격, 브랜드·제품명은 넣지 않는다). 정식명·접미어 뗀 약칭으로 안 잡히는
 * 표기만 둔다(2026-10-10 일본 대형주 29종목 7일 기사 실측 — 이것 없이 JT 2건·JR東日本 0건·ファストリ 0건이었다).
 */
export const JA_COMPANY_ALIASES: Record<string, string[]> = {
  "2914": ["JT"],
  "9020": ["JR東日本"],
  "9022": ["JR東海"],
  "8035": ["東エレク"],
  "9983": ["ファストリ"],
  "3382": ["セブン&アイ", "セブン&アイHD"],
  "9984": ["ソフトバンクG", "SBG"],
  "8306": ["三菱UFJ", "MUFG", "三菱UFJFG"],
  "8316": ["三井住友FG", "SMFG"],
  "8411": ["みずほFG", "みずほ"],
  // "武田" 단독은 넣지 않는다 — 흔한 성(배우 武田鉄矢·축구 武田修宏·고교 야구 武田高 …)이라 처음 보는 표본에서 30건 중 27건이 오답이었다
  "4502": ["武田薬", "タケダ"],
  "7267": ["ホンダ"],
  "8766": ["東京海上", "東京海上HD"],
  "6098": ["リクルート", "リクルートHD"],
  "6758": ["ソニーG", "ソニーグループ"],
  "6501": ["日立"],
  "7011": ["三菱重", "三菱重工"],
  "1925": ["大和ハウス"],
  "4661": ["OLC"],
  "7203": ["トヨタ"],
  "9432": ["NTT"],
  "9433": ["KDDI"],
  "6273": ["SMC"],
  "4568": ["第一三共"],
  "6954": ["ファナック"],
  "6902": ["デンソー"],
  "6367": ["ダイキン"],
  "8058": ["三菱商"],
  "2802": ["味の素"],
  "6861": ["キーエンス"],
  "7974": ["任天堂"],
};

/** 저품질·스팸·개인 영상(구글 뉴스 일본판 실측 2026-10-10 — 제목에 무관한 영문 꼬리가 붙은 자동 생성 글, 데이트레이딩 영상, X 글 모음) */
export const JA_LOW_VALUE_PUBLISHERS = new Set(["Unisba Media", "BigGo ファイナンス", "BigGo Finance", "Howl.Link", "Howl.link", "YouTube", "note", "pando.life"]);
/** 팬 블로그·판매점 블로그("ソニーが基本的に好き。"·"ソニーショップ テックスタッフ") — 매체명 꼴로 가른다 */
const JA_FAN_SHOP_PUBLISHER_RE = /が(?:基本的に)?好き|ショップ|ストア(?!ーズ)/;

/** 시황·나열·주가 자동 페이지 — 그 회사 얘기가 아니라 시장 전체 흐름·종목 목록(실측 표본: 日経平均寄与度·先物OP市況·ADR主要銘柄·寄り付き概況 …) */
const JA_ROUNDUP_RE =
  /日経平均|TOPIX|東証(?:後場|前場|一時|\d+時)|前場|後場|寄り付き|寄付き|大引け|引け後|寄与度|先物・?OP|ADR主要銘柄|オンライン証券動向|PTS|動いた株|出来た株|特別気配|ストップ高|ストップ安|値上がり率|値下がり率|上昇率|下落率|ランキング|注目(?:個別)?銘柄|\d+銘柄|銘柄一覧|主な銘柄|あす上がる|明日の株|本日の買い売り|買い売り優勢|デイトレ|株価・株式情報|掲示板|AIが解説|今の株価の理由|新興市場|市況|相場概況|株式市場概況|騰落率|公表仲値|変更報告書|大量保有|特例報告|保有割合/;

/** 같은 기사의 사진·갤러리 페이지 — 원기사와 중복 */
const JA_PHOTO_RE = /^[<＜]?画像\s*\d|【(?:写真・)?画像】|\d+枚目の写真|フォトギャラリー|写真特集|画像\s*\d+\s*\/\s*\d+|写真・画像\s*[(（]\d|^写真[:：]|^ギャラリー[:：]/;

/**
 * 할인·판촉·홍보 — 판촉 문맥이 같이 있을 때만(2026-10-10 리뷰 — "トヨタ、Amazonと物流で提携"·"新車販売キャンペーンを拡大" 같은 회사 기사가
 * 낱말 하나("Amazon"·"キャンペーン")로 빠지던 것). 세일·할인율·쿠폰·추첨 경품·무료 세미나·협찬 행사·평판 비교 글.
 */
const JA_PROMO_RE =
  /タイムセール|セール(?:中|開催|情報|対象)|\d+\s*[%％]\s*(?:オフ|OFF)|クーポン(?:配布|配信|コード|付|で|を?プレゼント)|ポイント還元|抽選で|名様に|プレゼントキャンペーン|無料(?:オンライン)?セミナー|ウェビナー|協賛|評判・口コミ|口コミ・評判/;

/**
 * 기업·주가와 무관한 소비자 글(2026-10-10 리뷰 — 엄격 기준 "기업·주가 뉴스"): 직원 연봉 정보, 시승기·제품 리뷰·구매 안내.
 * 신제품 발표·리콜·판매 실적 같은 회사 발표는 그대로 둔다.
 */
const JA_CONSUMER_RE = /年収|試乗記|試乗レポート|試乗インプレ|インプレッション|(?<!決算|業績|四半期|中間|期末)レビュー|購入ガイド|買うならどのグレード|どれを買う|おすすめ(?:編成|モデル|グレード)/;

/** 약칭 바로 뒤에 붙어도 같은 회사로 보는 말("ソニー傘下"·"トヨタ株"·"ホンダ新型") — 그 밖의 한자·가타카나가 붙으면 다른 낱말("ソニー生命"·"日立建機"·"本田響矢") */
const JA_ALIAS_SUFFIX_OK = /^(?:傘下|系|株|製|社長|会長|副社長|首脳|幹部|本社|子会社|側|決算|新型|新車|首位|次期|式|改革)/;

/**
 * 지역 판매회사(딜러) — "栃木トヨタ"·"熊本トヨタ自動車"·"東京ホンダ"는 그 지역 독립 판매회사라 상장사 기사가 아니다(2026-10-10 7203 표본).
 * 이름 바로 앞에 도도부현명이 붙은 자리는 인정하지 않는다. 바로 뒤에 붙은 자리도("東京エレクトロン宮城" — 지역 자회사) 마찬가지.
 */
const JA_PREFECTURES =
  "北海道|青森|岩手|宮城|秋田|山形|福島|茨城|栃木|群馬|埼玉|千葉|東京|神奈川|新潟|富山|石川|福井|山梨|長野|岐阜|静岡|愛知|三重|滋賀|京都|大阪|兵庫|奈良|和歌山|鳥取|島根|岡山|広島|山口|徳島|香川|愛媛|高知|福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|沖縄";
const JA_PREFECTURE_PREFIX_RE = new RegExp(`(?:${JA_PREFECTURES})$`);
const JA_PREFECTURE_AFTER_RE = new RegExp(`^(?:${JA_PREFECTURES})`);

/**
 * 같은 이름을 쓰는 일본 상장사 — 일본어 제목용(한국어 JP_SHARED_NAME_CONTEXT 와 같은 원칙). 일본 언론은 그룹을 "ソフトバンクG"·"SBG"로
 * 쓰고 "ソフトバンク" 단독은 대개 통신(9434)이다 — 그래도 OpenAI·孫正義 기사에 "ソフトバンク" 단독 표기가 섞여(TradingKey 등) 문맥어로 가른다.
 * 그룹 표기("ソフトバンクG"·"ソフトバンクグループ"·"SBG")는 9984 문맥어이자 9434 에는 다른 종목 문맥어다(2026-10-10 리뷰 — 9434 에서
 * "ソフトバンクG、…通信網"이 통신 문맥어로 통과하던 것).
 */
export const JA_SHARED_NAME_CONTEXT: Record<string, Record<string, RegExp>> = {
  ソフトバンク: {
    "9984": /ソフトバンク\s*G(?![A-Za-z])|ソフトバンクグループ|SBG|孫|ビジョン・?ファンド|SVF|OpenAI|オープンAI|アーム|\bArm\b|スターゲート|社債|調達|出資|投資|株価|急落|急騰|続落|続伸/,
    "9434": /携帯|スマホ|料金|通信|回線|基地局|5G|6G|LINEヤフー|PayPay|ワイモバイル|IDC|クラウド|宮川/,
  },
};

/** 스포츠 — 회사 야구부·실업팀·프로 구단 기사(제목 어디든) */
const JA_SPORTS_RE = /ホークス|野球|甲子園|選手権|駅伝|実業団|ラグビー|リーグワン|陸上部|大会出場/;
/** 이름 바로 뒤가 "・林監督" — 회사 팀 감독·선수 얘기(2026-10-10 리뷰 — "日立製作所・林監督"). 사람 이름이 붙은 꼴만("監督委員会·監督官庁"는 아님) */
const JA_SPORTS_AFTER_RE = /^・[^、。\s・]{1,4}(?:監督|選手|主将|コーチ)(?!委員|官庁|強化|当局|責任|下)/;

const KATAKANA = /[ァ-ヺー]/;
const KANJI = /[㐀-䶿一-鿿々]/;
const ASCII_WORD = /[A-Za-z0-9]/;

/** 일본어 제목 정규화(NFKC — 전각 영숫자·기호를 반각으로) */
export function jaNorm(s: string): string {
  return s.normalize("NFKC");
}

/**
 * 일본어 제목에서 이름 찾기 — 낱말 경계. 가타카나 이름은 앞뒤가 가타카나로 이어지면 다른 낱말("トヨタ紡織"은 한자라 strict 에서 거른다).
 * 가타카나로 끝나는 이름 뒤에 회사 형태 접미어(G·HD·FG·FH·GHD)가 붙으면 다른 이름("ソフトバンクG"·"ソニーFG"). "トヨタEV"·"ソニーAI"·"ホンダN-BOX"는 인정.
 * strict(약칭): 뒤에 한자·가타카나가 바로 붙으면 다른 낱말이다 — "本田響矢"(배우)·"武田鉄矢"(배우)·"日立建機"(다른 회사)·"ソニー生命"(다른 회사).
 * 영문·숫자 이름("JT"·"SMC"·"NTT")은 영문 낱말 경계.
 */
export function jaTitleHit(text: string, word: string, strict: boolean): boolean {
  return jaTitleHitAt(text, word, strict) >= 0;
}

/** jaTitleHit 과 같고 처음 맞은 자리를 돌려준다(없으면 -1) */
function jaTitleHitAt(text: string, word: string, strict: boolean): number {
  if (!word) return -1;
  if (/^[A-Za-z0-9&]+$/.test(word)) return text.search(new RegExp(`(?<![A-Za-z0-9])${esc(word)}(?![A-Za-z0-9])`));
  let from = 0;
  for (;;) {
    const i = text.indexOf(word, from);
    if (i < 0) return -1;
    from = i + 1;
    const before = text[i - 1] ?? "";
    const rest = text.slice(i + word.length);
    const after = rest[0] ?? "";
    if (KATAKANA.test(word[0]) && KATAKANA.test(before)) continue;
    if (JA_PREFECTURE_PREFIX_RE.test(text.slice(Math.max(0, i - 4), i))) continue;
    if (KATAKANA.test(word[word.length - 1]) && KATAKANA.test(after)) continue;
    if (KATAKANA.test(word[word.length - 1]) && /^(?:G|HD|FG|FH|GHD|HLDGS?)(?![A-Za-z0-9-])/.test(rest)) continue;
    if (ASCII_WORD.test(word[word.length - 1]) && ASCII_WORD.test(after)) continue;
    if (strict && (KANJI.test(after) || KATAKANA.test(after)) && !JA_ALIAS_SUFFIX_OK.test(rest)) continue;
    if (JA_PREFECTURE_AFTER_RE.test(rest)) continue;
    return i;
  }
}

export interface JaNames {
  symbol: string;
  /** 정식명·관용 약칭(JA_COMPANY_ALIASES) — 뒤에 한자가 이어져도 인정("トヨタ自動車"·"日立製作所") */
  names: string[];
  /** 접미어를 뗀 약칭("トヨタ"·"ソニー") — strict 경계 */
  aliases: string[];
  /** 회사 자체 페이지 판정용 — 일본어 정식명 */
  selfJa: string;
  /** 회사 자체 페이지 판정용 — 영문명(소문자, 법인 접미어 뗌, 예 "sony group"·"japan tobacco") */
  selfEn: string;
}

/**
 * 회사 자체 페이지 — 매체명이 회사명이면(일본어 정식명 포함, 영문명 전체로 시작, 영문명 첫 낱말과 정확히 같음).
 * 첫 낱말만으로 앞부분 비교를 하면 "Japan Today"가 Japan Tobacco 자체 페이지로 빠졌다(2026-10-10 리뷰).
 */
function isSelfPublisher(pub: string, n: JaNames): boolean {
  if (/公式|ニュースルーム|newsroom|IR情報/i.test(pub)) return true;
  if (n.selfJa && pub.includes(n.selfJa)) return true;
  const p = pub.toLowerCase().replace(/[,.]/g, " ").replace(/\s+/g, " ").trim();
  if (!n.selfEn) return false;
  const first = n.selfEn.split(" ")[0];
  return p.startsWith(n.selfEn) || (first.length >= 3 && p === first) || (first.length >= 3 && p === `${first} global`);
}

/** "トヨタ、ホンダ、日産…" 나열 구분점 수 — 가타카나 사이의 "・"(「ホンダ・プレリュード」 같은 이름 안 가운뎃점)는 세지 않는다 */
function listSeparators(t: string): number {
  let n = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "、" || c === ",") n++;
    else if (c === "・" && !(KATAKANA.test(t[i - 1] ?? "") && KATAKANA.test(t[i + 1] ?? ""))) n++;
  }
  return n;
}

/** 일본어 기사 판정(제목 기준 — 국내·해외 규칙과 같은 원칙) */
export function judgeJapaneseTitle(rawTitle: string, publisher: string, n: JaNames): Verdict {
  const t = jaNorm(rawTitle);
  const pub = jaNorm(publisher);
  if (JA_LOW_VALUE_PUBLISHERS.has(publisher) || JA_LOW_VALUE_PUBLISHERS.has(pub)) return { keep: false, reason: "저품질·스팸 매체" };
  if (isSelfPublisher(pub, n)) return { keep: false, reason: "회사 자체 페이지" };
  if (JA_FAN_SHOP_PUBLISHER_RE.test(pub)) return { keep: false, reason: "팬·판매점 블로그" };
  if (JA_PHOTO_RE.test(t)) return { keep: false, reason: "사진·갤러리 페이지(원기사와 중복)" };
  if (JA_PROMO_RE.test(t)) return { keep: false, reason: "할인·판촉·홍보" };
  if (JA_CONSUMER_RE.test(t)) return { keep: false, reason: "기업·주가와 무관한 소비자 글(연봉·시승기·리뷰)" };
  let hit: string | null = null;
  let pos = -1;
  for (const [list, strict] of [[n.names, false], [n.aliases, true]] as const) {
    for (const w of list) {
      const at = jaTitleHitAt(t, w, strict);
      if (at >= 0) {
        hit = w;
        pos = at;
        break;
      }
    }
    if (hit) break;
  }
  if (!hit && new RegExp(`[【\\[(（<]${esc(n.symbol)}[】\\])）>]|東証[:：]?${esc(n.symbol)}`).test(t)) {
    hit = n.symbol;
    pos = t.indexOf(n.symbol);
  }
  // 같은 이름을 쓰는 다른 상장사("ソフトバンク" — 9984·9434): 그 이름으로만 걸렸으면 문맥어로 가른다
  for (const [word, bySym] of Object.entries(JA_SHARED_NAME_CONTEXT)) {
    const own = bySym[n.symbol];
    if (!own) continue;
    // 공유 이름 자체는 경계만 본다("ソフトバンク株価見通し" — 뒤에 한자가 붙어도 그 이름). "ソフトバンクG"처럼 더 긴 이름은 위에서 먼저 걸린다
    const at = hit === word ? pos : hit ? -1 : jaTitleHitAt(t, word, false);
    if (at < 0) continue;
    // 동명 이름이 구단명으로도 쓰인다("ソフトバンク率い5度の日本一" — 호크스) — 여기서는 감독·우승 같은 말도 스포츠로 본다
    if (JA_SPORTS_RE.test(t) || /監督|選手|日本一|優勝|球団/.test(t)) return { keep: false, reason: `${word} — 스포츠 기사(구단)` };
    // 문맥어는 매체 꼬리표를 뗀 제목에서만 본다("（共同通信）"의 "通信"이 통신 문맥어로 잡히던 것)
    const body = t.replace(/[(（][^)）]{1,30}[)）]\s*$/, "");
    const other = Object.entries(bySym).some(([s, re]) => s !== n.symbol && re.test(body));
    if (own.test(body) && !other) {
      hit = word;
      pos = at;
      break;
    }
    return { keep: false, reason: `${word} — 동명 종목, ${other ? "다른 종목 문맥어 있음" : "이 종목 문맥어 없음"}` };
  }
  if (!hit) return { keep: false, reason: "제목에 회사명 없음" };
  if (JA_ROUNDUP_RE.test(t)) return { keep: false, reason: "시황·나열 기사" };
  // 회사 야구부·실업팀·프로 구단 기사("社会人野球…日立、本大会逃す", "日立製作所・林監督")
  if (JA_SPORTS_RE.test(t) || JA_SPORTS_AFTER_RE.test(t.slice(pos + hit.length))) return { keep: false, reason: "스포츠 기사(구단·실업팀)" };
  // "アドバンテ、ソフトバンクGなどが…"·"トヨタ、ホンダ、日産…" — 구분점 3개 이상 나열이고 회사가 맨 앞이 아님
  if (listSeparators(t) >= 3 && pos > 0) return { keep: false, reason: "여러 회사 나열" };
  // "ＦＲＯＮＴＥＯ---反発、JTのR&D組織が…" — 피스코식 "종목명---" 머리는 그 종목 주가 기사(이 회사는 재료로만 나옴)
  const fisco = t.match(/^(.{1,24}?)-{2,3}/);
  if (fisco && !fisco[1].includes(hit)) return { keep: false, reason: "다른 종목 주가 기사" };
  if (/など[がは]?(?:上昇|下落|高い|安い|値上がり|値下がり)/.test(t) && pos > 0) return { keep: false, reason: "여러 회사 나열" };
  return { keep: true, reason: `제목에 ${hit}` };
}

/** 일본어 재게재 묶기용 제목 정규화 — 매체 꼬리표("(ロイター)"·"| 個別記事 | ニュース | トレーダーズ・ウェブ"·"(2026年10月9日掲載)"·"執筆: Fisco")를 떼고 기호·공백 제거 */
export function normalizeJaTitleForDedup(title: string): string {
  return jaNorm(title)
    .replace(/\s*\|.*$/, "")
    .replace(/執筆[:：]?.*$/, "")
    .replace(/[(（][^)）]{1,30}(?:掲載|ロイター|フィスコ|トレーダーズ・ウェブ|Bloomberg|ニュース|新聞|オンライン|日本版)[^)）]{0,10}[)）]\s*$/, "")
    .replace(/[-―—–=]\s*(?:FT|英紙|報道|ブルームバーグ|ロイター)\s*$/, "")
    .replace(/[\s"'“”‘’.,·、。・「」『』【】()（）!?！？:：\-ー―—–=~〜]/g, "")
    .toLowerCase();
}
