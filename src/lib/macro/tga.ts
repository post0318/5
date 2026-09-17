import "server-only";
import { fetchJson } from "@/lib/markets/http";
import type { MacroPoint } from "./fred";

/**
 * 미국 재무부 일반계정(TGA) 잔고 — 거시 핵심지표 (오너 요청 2026-09-17).
 *
 * 출처: 미국 재무부 Fiscal Data 공개 API(`api.fiscaldata.treasury.gov`,
 * Daily Treasury Statement). 키가 필요 없고 영업일마다 갱신된다.
 * FRED 에도 TGA 가 있지만(`WTREGEN`) **주간(수요일) 값**뿐이라, 세금 납부일
 * 전후로 며칠 새 수십조가 오가는 이 계정의 움직임을 놓친다. 그래서 이 지표만
 * FRED 가 아닌 재무부 원천을 직접 쓴다.
 *
 * 왜 보는가: TGA 는 정부가 연준에 둔 현금이다. 잔고가 늘면 시중에서 그만큼
 * 돈이 빠지고(국채 발행·세금 수납), 줄면 시중에 풀린다. 그래서 유동성
 * 흐름을 읽는 데 쓴다. 다만 부채한도 협상 뒤 잔고를 다시 쌓는 구간처럼
 * 방향만으로 좋고 나쁨을 단정하기 어려운 국면이 있어, 대시보드 점수화에는
 * 넣지 않는다(`goodDirection: "none"`).
 *
 * 데이터 주의: 응답의 "Closing Balance" 행은 `close_today_bal` 이 항상 null
 * 이고 실제 종가 잔고가 `open_today_bal` 에 들어있다(실측 2026-09-17).
 * 단위는 **백만 달러**.
 */

const ENDPOINT =
  "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/dts/operating_cash_balance";
const ACCOUNT = "Treasury General Account (TGA) Closing Balance";
/**
 * 대시보드가 6개월·12개월 변화와 12개월 최저·최고를 쓴다. 영업일 기준이라
 * 1년이 약 250건 — 800건으로는 1년치밖에 안 와서(실측 2026-09-17: 260점,
 * 12개월 변화 계산 불가) 3년 남짓 담기게 넉넉히 잡는다.
 */
const PAGE_SIZE = 1000;

interface Row {
  record_date: string;
  account_type: string;
  close_today_bal: string | null;
  open_today_bal: string | null;
}

export async function fetchTgaSeries(): Promise<MacroPoint[]> {
  const url =
    `${ENDPOINT}?filter=${encodeURIComponent(`account_type:eq:${ACCOUNT}`)}` +
    `&fields=record_date,account_type,close_today_bal,open_today_bal` +
    `&sort=-record_date&page%5Bsize%5D=${PAGE_SIZE}`;

  const body = await fetchJson<{ data?: Row[] }>(url, {
    headers: { accept: "application/json" },
    revalidate: 60 * 60 * 6,
  });

  const out: MacroPoint[] = [];
  for (const r of body.data ?? []) {
    // 위 주석대로 close 가 비어 있으면 open 을 쓴다 — 둘 다 "그날 종가 잔고"다.
    const raw = r.close_today_bal && r.close_today_bal !== "null"
      ? r.close_today_bal
      : r.open_today_bal;
    const millions = Number(raw);
    if (!Number.isFinite(millions)) continue;
    // 조 달러 단위로 보기 좋게 환산 (백만 → 십억)
    out.push({ date: r.record_date, value: millions / 1000 });
  }
  // 대시보드는 오래된 것부터 정렬된 시계열을 기대한다
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
