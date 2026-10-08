/**
 * 브라질 국채 NTN-F ~10년 롤링 수익률(중간값) — 5번이 직접 수집한다(2026-10-06 오너 지시 — 4번 프로젝트 의존 제거).
 *
 * 정의는 4번 프로젝트(post0318/4 `scripts/fetch-ntnf-snapshot.mjs`, 9f05448·ce5b298 — 2026-10-07)와 **같다**
 * (오너 결정 2026-10-09 "4번과 같은 중간값 기준"). 겹치는 기간 날짜별 정확 일치를 확인했다:
 *   - 날짜마다 만기가 (기준일 + 10년)에 가장 가까운 NTN-F 하나(거리 = 절댓값, 같으면 자료에서 먼저 나온 종목).
 *   - 값의 우선순위:
 *       1) ANBIMA 2차시장 지표금리(Tx. Indicativas — 기관 간 종가 기준 중간값). src "anbima"
 *          공개 일일 파일 https://www.anbima.com.br/informacoes/merc-sec/arqs/msYYMMDD.txt (인증 없음, latin1, "@" 구분,
 *          칸 = Titulo@Data Referencia@Codigo SELIC@Data Base@Data Vencimento@Tx. Compra@Tx. Venda@Tx. Indicativas@…).
 *          약 4주치만 남는다(실측 2026-10-09: 09-11 은 있고 09-09·09-10 은 404) — 그래서 받은 날을 DB 에 누적한다.
 *       2) 재무부 CSV 중간값 = round2((Taxa Compra + Taxa Venda) / 2)(오전 호가). src "csv-mid".
 *          Taxa Compra 가 비어 있으면 4번처럼 Taxa Venda 그대로(src "csv-sell"). Taxa Venda 가 빈 줄은 후보에서 뺀다.
 *       (4번의 3순위 "실시간 임시값(live)"은 쓰지 않는다 — 주간 리포트는 확정 자료만, 오너 결정 2026-10-09.)
 *   - 휴일: 자료에 기준일이 있는 날만. 보간 없음.
 *   - 날짜 산술은 UTC(4번은 UTC 인 GitHub 실행 서버에서 `new Date(date)`·`setFullYear` — 2월 29일 + 10년 = 3월 1일).
 */
export const NTNF_CSV_URL =
  "https://www.tesourotransparente.gov.br/ckan/dataset/df56aa42-484a-4a59-8184-7676580c81e3/resource/796d2059-14e9-44e3-80c9-2d9e30b405c1/download/precotaxatesourodireto.csv";
export const ANBIMA_MS_BASE = "https://www.anbima.com.br/informacoes/merc-sec/arqs";

const NTNF_TYPE_PREFIX = "Tesouro Prefixado com Juros Semestrais;";

export type NtnfSrc = "anbima" | "csv-mid" | "csv-sell";

export interface NtnfRow {
  maturityDate: string; // YYYY-MM-DD
  dataBase: string; // YYYY-MM-DD
  buyRate: number | null;
  sellRate: number | null;
}

export interface NtnfPoint {
  date: string; // 기준일 YYYY-MM-DD
  ytm: number; // %
  maturityYear: number;
  maturityDate: string;
  src: NtnfSrc;
}

function parseBrDate(s: string): string | null {
  const m = s.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function parseBrNumber(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t.replace(",", "."));
  return Number.isNaN(n) ? null : n;
}

const ymd8 = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

/** 만기가 (date + 10년)에 가장 가까운 항목(같은 거리면 먼저 나온 것) */
function pickTenYear<T extends { maturityDate: string }>(date: string, items: T[]): T | null {
  const target = new Date(date);
  target.setUTCFullYear(target.getUTCFullYear() + 10);
  let best: T | null = null;
  let bestDiff = Infinity;
  for (const it of items) {
    const diff = Math.abs(new Date(it.maturityDate).getTime() - target.getTime());
    if (diff < bestDiff) {
      bestDiff = diff;
      best = it;
    }
  }
  return best;
}

/** CSV 한 줄 → NTN-F 줄(아니면 null) */
export function parseNtnfLine(line: string): NtnfRow | null {
  if (!line.startsWith(NTNF_TYPE_PREFIX)) return null;
  const cols = line.split(";");
  if (cols.length < 7) return null;
  const maturityDate = parseBrDate(cols[1]);
  const dataBase = parseBrDate(cols[2]);
  if (!maturityDate || !dataBase) return null;
  return { maturityDate, dataBase, buyRate: parseBrNumber(cols[3]), sellRate: parseBrNumber(cols[4]) };
}

/** CSV 날짜별 ~10년 중간값. rows 는 CSV 순서 그대로. since 이상 날짜만. */
export function ntnfTenYearPoints(rows: NtnfRow[], since = ""): NtnfPoint[] {
  const byDate = new Map<string, NtnfRow[]>();
  for (const r of rows) {
    if (typeof r.sellRate !== "number" || r.dataBase < since) continue;
    let list = byDate.get(r.dataBase);
    if (!list) byDate.set(r.dataBase, (list = []));
    list.push(r);
  }
  const points: NtnfPoint[] = [];
  for (const [date, list] of [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const best = pickTenYear(date, list);
    if (!best || best.sellRate == null) continue;
    const hasBuy = typeof best.buyRate === "number";
    // 4번과 같은 식·같은 연산 순서(부동소수 결과까지 같게)
    const ytm = hasBuy ? Math.round(((best.buyRate! + best.sellRate) / 2) * 100) / 100 : best.sellRate;
    points.push({ date, ytm, maturityYear: Number(best.maturityDate.slice(0, 4)), maturityDate: best.maturityDate, src: hasBuy ? "csv-mid" : "csv-sell" });
  }
  return points;
}

/** CSV 를 내려받으며 줄 단위로 NTN-F 줄만 모은다(전체 문자열을 메모리에 두지 않음). */
export async function fetchNtnfRows(url = NTNF_CSV_URL): Promise<NtnfRow[]> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`재무부 CSV 요청 실패 (HTTP ${res.status})`);
  const rows: NtnfRow[] = [];
  const decoder = new TextDecoder("utf-8");
  let rest = "";
  let lines = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    rest += done ? decoder.decode() : decoder.decode(value, { stream: true });
    const parts = rest.split("\n");
    rest = done ? "" : (parts.pop() ?? "");
    for (const line of parts) {
      lines++;
      const r = parseNtnfLine(line.replace(/\r$/, ""));
      if (r) rows.push(r);
    }
    if (done) break;
  }
  if (lines < 2 || !rows.length) throw new Error(`재무부 CSV 에 NTN-F 줄이 없음(전체 ${lines}줄) — 형식 변경 의심`);
  return rows;
}

/** ANBIMA 일일 파일 본문(latin1 해독된 문자열) → 그날 ~10년 지표금리. NTN-F 줄이 없으면 null */
export function parseAnbimaMs(text: string): NtnfPoint | null {
  let date: string | null = null;
  const items: { maturityDate: string; ind: number }[] = [];
  for (const line of text.split("\n")) {
    const c = line.trim().split("@");
    if (c[0] !== "NTN-F" || c.length < 8) continue;
    date = ymd8(c[1]);
    const ind = parseBrNumber(c[7]);
    if (ind == null) continue;
    items.push({ maturityDate: ymd8(c[4]), ind });
  }
  const best = date && items.length ? pickTenYear(date, items) : null;
  if (!date || !best) return null;
  return { date, ytm: best.ind, maturityYear: Number(best.maturityDate.slice(0, 4)), maturityDate: best.maturityDate, src: "anbima" };
}

/**
 * ANBIMA 기준일 하루치. 파일 없음(휴일·아직 미공개·보관 기간 지남 — HTTP 404)이면 null, 그 밖의 실패는 던진다.
 * 파일의 기준일이 요청한 날과 다르면 던진다(형식 변경 의심).
 */
export async function fetchAnbimaDay(date: string): Promise<NtnfPoint | null> {
  const [y, m, d] = date.split("-");
  const res = await fetch(`${ANBIMA_MS_BASE}/ms${y.slice(2)}${m}${d}.txt`, {
    headers: { "user-agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`ANBIMA ${date} HTTP ${res.status}`);
  const p = parseAnbimaMs(new TextDecoder("latin1").decode(await res.arrayBuffer()));
  if (!p) throw new Error(`ANBIMA ${date} 파일에 NTN-F 지표금리가 없음 — 형식 변경 의심`);
  if (p.date !== date) throw new Error(`ANBIMA ${date} 파일의 기준일이 ${p.date}`);
  return p;
}
