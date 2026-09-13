import "server-only";

/**
 * 한국은행 ECOS — 시장금리(일별) 817Y002.
 * 국고채·회사채 금리로 안전자산·신용 스프레드 컴포넌트 산출.
 */

const ITEMS = {
  gov3y: "010200000", // 국고채(3년)
  gov10y: "010210000", // 국고채(10년)
  corpAA: "010300000", // 회사채(3년, AA-)
  corpBBB: "010320000", // 회사채(3년, BBB-)
} as const;
export type EcosItem = keyof typeof ITEMS;

function key(): string {
  const k = process.env.ECOS_API_KEY;
  if (!k) throw new Error("ECOS_API_KEY 미설정");
  return k;
}

export interface RatePoint {
  date: string; // YYYY-MM-DD
  value: number;
}

/** 지정 기간(YYYYMMDD)의 일별 금리 시계열 */
export async function fetchRateSeries(
  item: EcosItem,
  startYmd: string,
  endYmd: string,
): Promise<RatePoint[]> {
  // ECOS API 는 인증키를 헤더가 아니라 URL 경로 세그먼트로 요구함(API 자체 설계,
  // 우회 불가). 에러/로그 메시지에 이 url 을 절대 포함시키지 말 것 — 키가 그대로
  // 노출됨. lib/markets/http.ts 의 fetchText/fetchJson 처럼 URL을 에러에 넣는
  // 공용 헬퍼로 나중에 바꾸면 키가 로그로 샐 수 있음 (2026-09 점검).
  const url = `https://ecos.bok.or.kr/api/StatisticSearch/${key()}/json/kr/1/5000/817Y002/D/${startYmd}/${endYmd}/${ITEMS[item]}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    next: { revalidate: 60 * 60 * 12 },
  });
  if (!res.ok) throw new Error(`ECOS ${item} ${res.status}`);
  const j = (await res.json()) as {
    StatisticSearch?: { row?: { TIME: string; DATA_VALUE: string }[] };
  };
  return (j.StatisticSearch?.row ?? [])
    .map((r) => ({
      date: `${r.TIME.slice(0, 4)}-${r.TIME.slice(4, 6)}-${r.TIME.slice(6, 8)}`,
      value: Number(r.DATA_VALUE),
    }))
    .filter((p) => Number.isFinite(p.value));
}

/** 최근값 한 건 (해당일 없으면 직전 영업일) */
export async function fetchLatestRates(endYmd: string): Promise<Record<EcosItem, number | null>> {
  const start = ymdMinusDays(endYmd, 14);
  const entries = await Promise.all(
    (Object.keys(ITEMS) as EcosItem[]).map(async (it) => {
      const s = await fetchRateSeries(it, start, endYmd).catch(() => []);
      return [it, s.at(-1)?.value ?? null] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<EcosItem, number | null>;
}

function ymdMinusDays(ymd: string, days: number): string {
  // UTC 로 파싱 + UTC 산술로 통일 — 로컬 파싱(Date 생성자)과 UTC 산술을 섞으면
  // 음수 오프셋 타임존(로컬 개발 환경)에서 ±1일 오차가 생김 (2026-09 수정)
  const d = new Date(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}
