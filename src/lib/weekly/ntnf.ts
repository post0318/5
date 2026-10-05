/**
 * 브라질 국채 NTN-F ~10년 롤링 수익률 계산 — 브라질 재무부 공개 CSV(Tesouro Transparente CKAN
 * `precotaxatesourodireto.csv`, 약 14MB·인증 불필요)에서 만든다(2026-10-06 오너 지시 — 4번 프로젝트 의존을 끊고 5번이 직접 수집).
 *
 * 규칙은 4번 프로젝트(post0318/4 `scripts/fetch-ntnf-snapshot.mjs`, cf10cda)와 **같다** — 겹치는 기간 날짜별 정확 일치를 확인했다:
 *   - 대상 줄: 첫 칸이 "Tesouro Prefixado com Juros Semestrais"(NTN-F). 칸 = 종류;만기일;기준일(Data Base);Taxa Compra;Taxa Venda;…
 *   - 날짜(기준일)마다 만기가 (기준일 + 10년)에 가장 가까운 종목 하나(거리 = 절댓값, 같으면 CSV 에서 먼저 나온 종목).
 *   - 값 = 그 종목의 **Taxa Venda Manhã**(5번째 칸, 매도/상환 수익률, %). Taxa Venda 가 비어 있는 줄은 후보에서 뺀다.
 *   - 휴일: CSV 에 기준일이 있는 날만(브라질 영업일). 보정·보간 없음. 거래 플랫폼 실시간 보정은 4번도 이 시계열엔 안 쓴다.
 *   - 날짜 산술은 UTC(4번은 UTC 인 GitHub 실행 서버에서 `new Date(date)`·`setFullYear` — 2월 29일 + 10년 = 3월 1일).
 */
export const NTNF_CSV_URL =
  "https://www.tesourotransparente.gov.br/ckan/dataset/df56aa42-484a-4a59-8184-7676580c81e3/resource/796d2059-14e9-44e3-80c9-2d9e30b405c1/download/precotaxatesourodireto.csv";

const NTNF_TYPE_PREFIX = "Tesouro Prefixado com Juros Semestrais;";

export interface NtnfRow {
  maturityDate: string; // YYYY-MM-DD
  dataBase: string; // YYYY-MM-DD
  sellRate: number | null;
}

export interface NtnfPoint {
  date: string; // 기준일 YYYY-MM-DD
  ytm: number; // %
  maturityYear: number;
  maturityDate: string;
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

/** CSV 한 줄 → NTN-F 줄(아니면 null) */
export function parseNtnfLine(line: string): NtnfRow | null {
  if (!line.startsWith(NTNF_TYPE_PREFIX)) return null;
  const cols = line.split(";");
  if (cols.length < 7) return null;
  const maturityDate = parseBrDate(cols[1]);
  const dataBase = parseBrDate(cols[2]);
  if (!maturityDate || !dataBase) return null;
  return { maturityDate, dataBase, sellRate: parseBrNumber(cols[4]) };
}

/** 날짜별 ~10년 롤링 종목 선택. rows 는 CSV 순서 그대로(같은 거리일 때 먼저 나온 종목). since 이상 날짜만. */
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
    const target = new Date(date);
    target.setUTCFullYear(target.getUTCFullYear() + 10);
    let best: NtnfRow | null = null;
    let bestDiff = Infinity;
    for (const r of list) {
      const diff = Math.abs(new Date(r.maturityDate).getTime() - target.getTime());
      if (diff < bestDiff) {
        bestDiff = diff;
        best = r;
      }
    }
    if (best && best.sellRate != null) {
      points.push({ date, ytm: best.sellRate, maturityYear: Number(best.maturityDate.slice(0, 4)), maturityDate: best.maturityDate });
    }
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
