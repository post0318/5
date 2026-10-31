import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { getAdapter } from "@/lib/markets/registry";
import type { MarketId } from "@/lib/markets/types";
import { normUrl } from "./sources";
import {
  type PptCompanyDoc,
  type PptMarket,
  type PptPoint,
  type PptShare,
  companyKey,
  getCompany,
  monthSpendUsd,
  pptUsageCol,
  setCompanyField,
} from "./store";
import { addEvidence, emptyEvidence, validatePoints, validateShare, type ShareInput } from "./validate";

/**
 * 발표자료 점유율·투자포인트 자동 채우기 — Claude API + 웹검색(오너 2026-10-31 「나」 방식).
 * 10-11 「Anthropic API 보류」를 이 기능에 한해 바꾼 결정. 종목뉴스의 Claude 금지는 그대로다.
 *
 * - 키 ANTHROPIC_API_KEY 가 없으면 꺼짐(호출 없음, 화면 안내). 오류로 죽지 않는다.
 * - 모델 PPT_CLAUDE_MODEL(기본 claude-sonnet-5-5), 노력 PPT_CLAUDE_EFFORT(기본 medium), 종목당 검색 상한 PPT_CLAUDE_MAX_SEARCHES(기본 6).
 * - 월 상한 PPT_CLAUDE_MONTHLY_BUDGET_USD(기본 10). 이번 달 추정 비용 + 이번 호출 최대 추정치가 넘으면 부르지 않는다.
 * - 호출마다 토큰·검색 수·추정 비용을 ppt_ai_usage 에 남긴다(400일).
 * - 저장은 커넥터 채우기와 같은 검증(validate.ts)·같은 저장 함수(store.ts setCompanyField)를 거친다.
 * - 숫자 대조: 웹검색 인용문(cited_text)에 같은 값이 있어야 남긴다. 출처 주소는 이번 검색 결과에 실제로 나온 주소만.
 */

export const PPT_CLAUDE_DEFAULT_MODEL = "claude-sonnet-5-5";

/** 100만 토큰당 달러(입력·출력·캐시 읽기·캐시 쓰기 5분). 웹검색 1회 0.01 달러. 2026-10 공시 단가 */
const PRICE: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
  "claude-sonnet-5-5": { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-5": { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-opus-5-5": { in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};
const SEARCH_USD = 0.01;
/** 이 호출이 넘을 수 없는 최대 추정치 — 월 상한 사전 검사용(검색 상한 × 0.01 + 입력 12만·출력 1.6만 토큰) */
function maxCallUsd(model: string, maxSearches: number): number {
  const p = PRICE[model] ?? PRICE["claude-opus-5"];
  return maxSearches * SEARCH_USD + (120_000 * p.in + 16_000 * p.out) / 1e6;
}

export function claudeFillConfig() {
  const key = process.env.ANTHROPIC_API_KEY ?? "";
  const model = process.env.PPT_CLAUDE_MODEL || PPT_CLAUDE_DEFAULT_MODEL;
  const budgetUsd = Number(process.env.PPT_CLAUDE_MONTHLY_BUDGET_USD ?? 10);
  const maxSearches = Math.max(1, Math.min(20, Number(process.env.PPT_CLAUDE_MAX_SEARCHES ?? 6)));
  const effort = (process.env.PPT_CLAUDE_EFFORT || "medium") as "low" | "medium" | "high";
  return {
    enabled: key.length > 0,
    reason: key.length > 0 ? null : "ANTHROPIC_API_KEY 가 없어 API 자동 채우기가 꺼져 있습니다(1호기 app.env 에 키를 넣으면 켜짐).",
    model,
    budgetUsd: Number.isFinite(budgetUsd) && budgetUsd >= 0 ? budgetUsd : 10,
    maxSearches,
    effort,
  };
}

export function costUsd(model: string, u: { input: number; output: number; cacheRead: number; cacheWrite: number; searches: number }): number {
  const p = PRICE[model] ?? PRICE["claude-opus-5"]; // 모르는 모델은 비싼 쪽으로 잡는다
  return (u.input * p.in + u.output * p.out + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite) / 1e6 + u.searches * SEARCH_USD;
}

const SUBMIT_TOOL: Anthropic.Beta.BetaTool = {
  name: "submit_ppt_fill",
  description:
    "조사를 마친 뒤 마지막에 한 번 부른다. 점유율과 투자포인트 세 줄을 출처와 함께 제출한다. 출처는 이번 웹검색 결과에 실제로 나온 주소만, 발행일(YYYY-MM-DD)을 반드시 적는다.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["share", "points"],
    properties: {
      share: {
        type: ["object", "null"],
        additionalProperties: false,
        required: ["business", "asOf", "rows", "sources"],
        properties: {
          business: { type: "string", description: "점유율 시장 이름(한국어, 예: 글로벌 D램)" },
          asOf: { type: "string", description: "기준 시점(예: 2026년 2분기)" },
          rows: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "value", "self"],
              properties: { name: { type: "string" }, value: { type: "number", description: "0~1 비율" }, self: { type: "boolean" } },
            },
          },
          sources: { $ref: "#/$defs/sources" },
        },
      },
      points: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "text", "sources"],
          properties: {
            kind: { type: "string", enum: ["founding", "business", "thesis"] },
            text: { type: "string" },
            sources: { $ref: "#/$defs/sources" },
          },
        },
      },
    },
    $defs: {
      sources: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["org", "title", "publishedAt", "url"],
          properties: { org: { type: "string" }, title: { type: "string" }, publishedAt: { type: "string" }, url: { type: "string" } },
        },
      },
    },
  },
};

const SYSTEM = `너는 증권사 리서치 보조다. 한 회사의 발표자료 한 장에 들어갈 「산업 점유율」과 「투자포인트 세 줄」을 웹검색으로 조사한다.
규칙(어기면 앱이 그 항목을 지운다):
- 숫자를 지어내지 않는다. 모든 수치는 검색 결과 원문에 그대로 있는 값만 쓰고, 그 원문을 인용하며 설명한다.
- 출처는 조사기관·증권사 리포트·회사 공시·실적 발표·주요 언론. 블로그·카페·커뮤니티·SNS·유튜브는 쓰지 않는다. 출처마다 발행일(YYYY-MM-DD)을 적는다.
- 점유율: 이 회사의 핵심 사업 시장 하나를 골라, 같은 출처·같은 기준 시점의 회사별 비중(이 회사 포함 상위 2~4곳)을 0~1 비율로. 「기타」는 넣지 않는다(앱이 계산). 확인되지 않으면 share 를 null 로.
- 투자포인트 세 줄(한국어, 줄마다 55자 안팎·한 문장):
  ① founding: 설립연도 + 회사의 사업 + 점유율(위 점유율 값과 같은 값)
  ② business: 현재 진행 중인 사업 부문(공시 기준)과 그 차별점 — 출처가 있는 문장만
  ③ thesis: 종합 핵심 투자포인트 — 근거 출처 필수, 목표주가·상승여력·근거 없는 전망 금지
- 조사가 끝나면 먼저 찾은 근거를 인용과 함께 짧게 정리하고, 마지막에 submit_ppt_fill 을 한 번 부른다.`;

interface Ctx {
  market: PptMarket;
  symbol: string;
  name: string;
  nameLocal: string | null;
  homepage: string | null;
  industry: string | null;
  foundingYear: number | null;
}

async function companyContext(market: PptMarket, symbol: string): Promise<Ctx> {
  const p = await getAdapter(market as MarketId).getCompanyProfile(symbol);
  // 한국 어댑터는 DART 기업개황 설립일(est_dt)을 listedDate 칸에 넣는다(이름 오류 — 상장일 아님, 2026-10-31 조사 확인)
  const est = market === "kr" ? /^(\d{4})/.exec(p.listedDate ?? "")?.[1] : null;
  return {
    market,
    symbol,
    name: p.name.replace(/\(주\)|㈜/g, "").trim(),
    nameLocal: p.nameLocal ?? null,
    homepage: p.homepage || null,
    industry: p.industry ?? null,
    foundingYear: est ? Number(est) : null,
  };
}

export interface FillResult {
  key: string;
  status: "saved" | "partial" | "rejected" | "skipped" | "disabled" | "budget" | "error";
  costUsd: number;
  webSearches: number;
  share: { saved: boolean; needsChoice: boolean; errors: string[]; warnings: string[] } | null;
  points: { saved: number; dropped: { kind: string; text: string; reason: string }[]; warnings: string[] } | null;
  note: string | null;
}

/** 비었거나 오래된(점유율 기준 시점 저장이 365일 넘음) 항목이 있으면 true — 같은 종목 두 번 안 함 */
export function needsFill(doc: PptCompanyDoc | null, now = Date.now()): boolean {
  if (!doc?.share || !doc.points?.lines?.length) return true;
  const old = (iso: string | undefined) => !iso || now - Date.parse(iso) > 365 * 864e5;
  return old(doc.share.at) || old(doc.points.at);
}

export async function fillCompany(
  market: PptMarket,
  symbol: string,
  opts: { by: string; force?: boolean; dryRun?: boolean; client?: Anthropic },
): Promise<FillResult> {
  const key = companyKey(market, symbol);
  const cfg = claudeFillConfig();
  const base: FillResult = { key, status: "skipped", costUsd: 0, webSearches: 0, share: null, points: null, note: null };
  if (!cfg.enabled && !opts.client) return { ...base, status: "disabled", note: cfg.reason };
  const existing = await getCompany(market, symbol);
  if (!opts.force && !needsFill(existing)) return { ...base, note: "이미 채워져 있고 1년 안 — 건너뜀" };
  const spent = await monthSpendUsd();
  const worst = maxCallUsd(cfg.model, cfg.maxSearches);
  if (spent + worst > cfg.budgetUsd) {
    return { ...base, status: "budget", note: `월 상한 ${cfg.budgetUsd}달러 — 이번 달 ${spent.toFixed(2)}달러 + 이번 호출 최대 ${worst.toFixed(2)}달러가 넘음` };
  }
  const ctx = await companyContext(market, symbol);
  const client = opts.client ?? new Anthropic();
  const user =
    `회사: ${ctx.name}${ctx.nameLocal && ctx.nameLocal !== ctx.name ? ` (${ctx.nameLocal})` : ""} · 시장 ${market.toUpperCase()} · 종목코드 ${symbol}` +
    (ctx.industry ? ` · 업종 ${ctx.industry}` : "") +
    (ctx.homepage ? ` · 누리집 ${ctx.homepage}` : "") +
    (ctx.foundingYear ? `\n설립연도(공시 원자료): ${ctx.foundingYear}년 — 첫 줄에 이 연도를 쓴다.` : "\n설립연도: 공시 원자료 없음 — 회사 공식 자료로 확인될 때만 쓴다.") +
    (existing?.share ? `\n기존 점유율(참고, 같은 사업이면 최신 값으로 갱신): ${existing.share.business} ${existing.share.asOf} ${existing.share.rows.map((r) => `${r.name} ${(r.value * 100).toFixed(1)}%`).join(", ")}` : "");

  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: user }];
  const ev = emptyEvidence();
  ev.retrievedUrls = new Set();
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, searches: 0 };
  let servedBy: string | null = null;
  let submitted: { share: ShareInput | null; points: PptPoint[] } | null = null;
  let note: string | null = null;
  let ok = false;
  try {
    for (let turn = 0; turn < 4; turn++) {
      const res = await client.beta.messages.create({
        model: cfg.model,
        max_tokens: 16000,
        system: SYSTEM,
        thinking: { type: "adaptive" },
        output_config: { effort: cfg.effort },
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: cfg.maxSearches }, SUBMIT_TOOL],
        tool_choice: { type: "auto" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        messages,
      });
      servedBy = res.model;
      usage.input += res.usage.input_tokens ?? 0;
      usage.output += res.usage.output_tokens ?? 0;
      usage.cacheRead += res.usage.cache_read_input_tokens ?? 0;
      usage.cacheWrite += res.usage.cache_creation_input_tokens ?? 0;
      usage.searches += res.usage.server_tool_use?.web_search_requests ?? 0;
      for (const b of res.content) {
        if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
          for (const r of b.content) if (r.type === "web_search_result") ev.retrievedUrls.add(normUrl(r.url));
        } else if (b.type === "text" && b.citations) {
          for (const c of b.citations) if (c.type === "web_search_result_location") addEvidence(ev, c.url, `${c.title ?? ""}\n${c.cited_text}`);
        } else if (b.type === "tool_use" && b.name === SUBMIT_TOOL.name) {
          submitted = b.input as { share: ShareInput | null; points: PptPoint[] };
        }
      }
      if (submitted) break;
      if (res.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: res.content });
        continue;
      }
      if (res.stop_reason === "refusal") {
        note = `모델이 거절함(${res.stop_details?.category ?? "분류 없음"})`;
        break;
      }
      note = `제출 도구를 부르지 않고 끝남(stop_reason ${res.stop_reason})`;
      break;
    }
    ok = Boolean(submitted);
  } catch (err) {
    note = err instanceof Anthropic.APIError ? `API 오류 ${err.status}: ${err.message}` : `호출 실패: ${err instanceof Error ? err.message : String(err)}`;
    console.error("[ppt-claude-fill]", key, note);
  }
  const model = servedBy ?? cfg.model;
  const cost = costUsd(model, usage);
  await (await pptUsageCol()).insertOne({
    at: new Date(),
    key,
    model: cfg.model,
    servedBy,
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    webSearches: usage.searches,
    costUsd: cost,
    ok,
    note,
  });
  const out: FillResult = { ...base, costUsd: cost, webSearches: usage.searches, note };
  if (!submitted) return { ...out, status: "error" };

  const sub: { share: ShareInput | null; points: PptPoint[] } = submitted;
  const stamp = { by: opts.by, via: "claude-api" as const };
  const now = new Date().toISOString();
  let shareSaved: PptShare | null = null;
  if (sub.share) {
    const sr = validateShare(sub.share, ev, { companyName: ctx.name, existing: existing?.share ?? null });
    out.share = { saved: false, needsChoice: sr.needsChoice, errors: sr.errors, warnings: sr.warnings };
    if (sr.ok && sr.share) {
      if (!opts.dryRun) {
        if (sr.needsChoice) {
          await setCompanyField(market, symbol, "shareCandidates", [...(existing?.shareCandidates ?? []), { ...sr.share, at: now, ...stamp }], stamp);
        } else {
          await setCompanyField(market, symbol, "share", { ...sr.share, at: now, ...stamp }, stamp);
        }
      }
      out.share.saved = !sr.needsChoice;
      if (!sr.needsChoice) shareSaved = sr.share;
    }
  } else {
    out.share = { saved: false, needsChoice: false, errors: ["점유율 확인 안 됨(share null)"], warnings: [] };
  }
  const selfShare = shareSaved ?? existing?.share ?? null;
  const selfPct = selfShare ? `${(Math.round(selfShare.rows[0].value * 1000) / 10).toFixed(1).replace(/\.0$/, "")}%` : null;
  const pr = validatePoints(sub.points ?? [], ev, { allowedNumbers: [], foundingYear: ctx.foundingYear, shareSelfPct: selfPct });
  out.points = { saved: pr.lines.length, dropped: pr.dropped, warnings: pr.warnings };
  if (pr.lines.length && !opts.dryRun) {
    await setCompanyField(market, symbol, "points", { lines: pr.lines, at: now, ...stamp }, stamp);
  }
  out.status = out.share?.saved && pr.lines.length === 3 ? "saved" : out.share?.saved || pr.lines.length ? "partial" : "rejected";
  return out;
}
