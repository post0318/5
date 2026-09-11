import "server-only";

/**
 * 헤드라인이 실제로 해당 기업 고유 기사인지 판정. 지금은 "제목에 회사명(또는
 * 흔한 표기 변형)이 실제로 들어있는가"만 보는 무료 휴리스틱 — 시황·지수
 * 기사(예: "코스피 7000선...")나 회사명이 본문에만 언급된 기사(예: ETF 상품명
 * 기사)를 걸러낸다. 제목에 이름이 없으면 기사 자체가 그 회사 것이 아닐
 * 가능성이 높다는 전제.
 *
 * API 키 확보 후 LLM 판정(Haiku 배치 호출, 시황성 기사인지 의미 판단)으로
 * 교체 예정 — 그때도 이 함수 시그니처(제목·회사명 배열 → 통과분 배열)만
 * 유지하면 호출부(fetchStockNews 등) 수정 없이 내부 구현만 바꾸면 된다.
 */
export interface RelevanceCandidate {
  title: string;
}

const SUFFIX_RE =
  /\(주\)|㈜|주식회사|株式会社|,?\s*(Inc|Corp|Corporation|Co\.?,?\s*Ltd|Ltd|PLC|N\.V\.|S\.A\.)\.?$/gi;
const PREFIX_ALIASES: [RegExp, string][] = [
  [/^에스케이/, "SK"],
  [/^엘지/, "LG"],
  [/^지에스/, "GS"],
  [/^케이티/, "KT"],
  [/^에이치디/, "HD"],
  [/^씨제이/, "CJ"],
];

function shortNames(companyName: string): string[] {
  const base = companyName.replace(SUFFIX_RE, "").trim();
  const names = new Set<string>([base]);
  for (const [re, rep] of PREFIX_ALIASES) {
    if (re.test(base)) names.add(base.replace(re, rep));
  }
  return [...names].filter((n) => n.length >= 2);
}

function titleMentionsCompany(title: string, companyName: string): boolean {
  const names = shortNames(companyName);
  const t = title.toLowerCase();
  return names.some((n) => t.includes(n.toLowerCase()));
}

/** companyName 이 없으면(회사명 미확보) 필터링하지 않고 통과시킨다. */
export async function filterCompanySpecific<T extends RelevanceCandidate>(
  items: T[],
  companyName: string | null | undefined,
): Promise<T[]> {
  if (!companyName) return items;
  return items.filter((it) => titleMentionsCompany(it.title, companyName));
}
