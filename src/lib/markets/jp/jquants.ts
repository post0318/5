import "server-only";
import { AdapterError } from "../types";
import type {
  FinancialLineItem,
  FinancialPeriod,
  FinancialPeriodType,
  FinancialStatement,
} from "../types";

/**
 * J-Quants API (일본) — 분기·연간 재무제표 (`/v1/fins/statements`)
 *
 * 인증: 이메일/비밀번호 → refreshToken → idToken(24h). idToken 캐시.
 * ⚠️ 무료 플랜은 12주 지연. 일부 네트워크(클라우드 IP)에서 API Gateway가 차단(403)될 수 있음.
 *    이 경우 자동으로 EDINET 폴백.
 */

const BASE = "https://api.jquants.com/v1";

export function hasJQuants(): boolean {
  return Boolean(process.env.JQUANTS_EMAIL && process.env.JQUANTS_PASSWORD);
}

let idToken: { value: string; exp: number } | null = null;
let refreshToken: { value: string; exp: number } | null = null;

async function post(path: string): Promise<Response> {
  return fetch(`${BASE}${path}`, { method: "POST", signal: AbortSignal.timeout(15_000) });
}

async function getRefreshToken(): Promise<string> {
  if (refreshToken && refreshToken.exp > Date.now()) return refreshToken.value;
  const res = await fetch(`${BASE}/token/auth_user`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mailaddress: process.env.JQUANTS_EMAIL,
      password: process.env.JQUANTS_PASSWORD,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new AdapterError(
      `J-Quants 로그인 실패 (${res.status}) — 자격증명 또는 네트워크(엣지 차단) 확인`,
      { status: res.status },
    );
  }
  const j = (await res.json()) as { refreshToken?: string };
  if (!j.refreshToken) throw new AdapterError("J-Quants refreshToken 없음", { status: 502 });
  refreshToken = { value: j.refreshToken, exp: Date.now() + 6 * 24 * 3600 * 1000 };
  return j.refreshToken;
}

async function getIdToken(): Promise<string> {
  if (idToken && idToken.exp > Date.now()) return idToken.value;
  const rt = await getRefreshToken();
  const res = await post(`/token/auth_refresh?refreshtoken=${encodeURIComponent(rt)}`);
  if (!res.ok) {
    refreshToken = null; // 다음 시도에서 재로그인
    throw new AdapterError(`J-Quants 토큰 갱신 실패 (${res.status})`, { status: res.status });
  }
  const j = (await res.json()) as { idToken?: string };
  if (!j.idToken) throw new AdapterError("J-Quants idToken 없음", { status: 502 });
  idToken = { value: j.idToken, exp: Date.now() + 23 * 3600 * 1000 };
  return j.idToken;
}

interface JQStatement {
  DisclosedDate: string;
  LocalCode: string;
  TypeOfDocument: string;
  TypeOfCurrentPeriod: string; // "FY" | "1Q" | "2Q" | "3Q"
  CurrentPeriodEndDate: string;
  CurrentFiscalYearEndDate: string;
  NetSales: string;
  OperatingProfit: string;
  OrdinaryProfit: string;
  Profit: string;
  EarningsPerShare: string;
  TotalAssets: string;
  Equity: string;
  BookValuePerShare: string;
  CashFlowsFromOperatingActivities: string;
  CashFlowsFromInvestingActivities: string;
  CashFlowsFromFinancingActivities: string;
  CashAndEquivalents: string;
}

function n(v: string | undefined): number | null {
  if (v == null || v === "" || v === "-") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

interface FieldSpec {
  key: keyof JQStatement;
  label: string;
  section: "손익계산서" | "재무상태표";
  highlight: boolean;
}
const FIELDS: FieldSpec[] = [
  { key: "NetSales", label: "売上高", section: "손익계산서", highlight: true },
  { key: "OperatingProfit", label: "営業利益", section: "손익계산서", highlight: true },
  { key: "OrdinaryProfit", label: "経常利益", section: "손익계산서", highlight: false },
  { key: "Profit", label: "当期純利益", section: "손익계산서", highlight: true },
  { key: "EarningsPerShare", label: "1株当たり当期純利益 (円)", section: "손익계산서", highlight: false },
  { key: "TotalAssets", label: "総資産", section: "재무상태표", highlight: true },
  { key: "Equity", label: "純資産 / 自己資本", section: "재무상태표", highlight: true },
  { key: "BookValuePerShare", label: "1株当たり純資産 (円)", section: "재무상태표", highlight: false },
  { key: "CashFlowsFromOperatingActivities", label: "営業活動によるキャッシュ・フロー", section: "재무상태표", highlight: false },
  { key: "CashFlowsFromInvestingActivities", label: "投資活動によるキャッシュ・フロー", section: "재무상태표", highlight: false },
  { key: "CashFlowsFromFinancingActivities", label: "財務活動によるキャッシュ・フロー", section: "재무상태표", highlight: false },
];

export async function fetchJQuantsFinancials(
  code: string,
  periodType: FinancialPeriodType,
): Promise<FinancialStatement | null> {
  const token = await getIdToken();
  const local = code.replace(/[^0-9]/g, "");
  const res = await fetch(`${BASE}/fins/statements?code=${local}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new AdapterError(`J-Quants statements 실패 (${res.status})`, { status: res.status });
  const j = (await res.json()) as { statements?: JQStatement[] };
  const all = j.statements ?? [];
  if (all.length === 0) return null;

  const wanted =
    periodType === "annual"
      ? all.filter((s) => s.TypeOfCurrentPeriod === "FY")
      : all.filter((s) => ["1Q", "2Q", "3Q"].includes(s.TypeOfCurrentPeriod));

  // 기간별 최신 공시만 (정정 대응), 최근순 6개
  const byPeriod = new Map<string, JQStatement>();
  for (const s of wanted) {
    const k = `${s.CurrentPeriodEndDate}|${s.TypeOfCurrentPeriod}`;
    const prev = byPeriod.get(k);
    if (!prev || s.DisclosedDate > prev.DisclosedDate) byPeriod.set(k, s);
  }
  const rows = [...byPeriod.values()]
    .sort((a, b) => b.CurrentPeriodEndDate.localeCompare(a.CurrentPeriodEndDate))
    .slice(0, 6);
  if (rows.length === 0) return null;

  const periods: FinancialPeriod[] = rows.map((s) => {
    const y = Number(s.CurrentPeriodEndDate.slice(0, 4));
    const q = s.TypeOfCurrentPeriod === "FY" ? null : Number(s.TypeOfCurrentPeriod[0]);
    return {
      label: q ? `${y} ${s.TypeOfCurrentPeriod}` : `FY${y}`,
      fiscalYear: y,
      fiscalQuarter: q,
      endDate: s.CurrentPeriodEndDate,
    };
  });

  const sectionOrder = ["손익계산서", "재무상태표"] as const;
  const sections = sectionOrder
    .map((title) => {
      const items: FinancialLineItem[] = [];
      for (const f of FIELDS) {
        if (f.section !== title) continue;
        const values: Record<string, number | null> = {};
        let hasAny = false;
        rows.forEach((s, i) => {
          const v = n(s[f.key]);
          values[periods[i].label] = v;
          if (v != null) hasAny = true;
        });
        if (!hasAny) continue;
        items.push({
          accountName: f.label,
          depth: 0,
          isSubtotal: f.highlight,
          isHighlight: f.highlight,
          values,
        });
      }
      return { title, items };
    })
    .filter((s) => s.items.length > 0);

  if (sections.length === 0) return null;

  return {
    symbol: code,
    market: "jp",
    periodType,
    unit: "円",
    currency: "JPY",
    consolidation: "consolidated",
    periods,
    sections,
    source: "J-Quants /fins/statements (12週遅延の可能性)",
    sourceUrl: "https://jpx-jquants.com/",
  };
}
