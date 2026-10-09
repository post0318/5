import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { isDbConfigured } from "@/lib/db";
import type { ConnectorComments } from "@/lib/weekly/comment";
import { getConnectorData, saveConnectorDraft, WeeklyGenerateError } from "@/lib/weekly/generate";

/**
 * 주간 리포트 원격 MCP 서버 — claude.ai 사용자 정의 커넥터용(오너 지시 2026-10-10).
 *
 * Anthropic API 는 구독과 별도 과금이라 쓰지 않고, 오너 구독의 claude.ai 가 이 서버의
 * 도구 두 개를 불러 해석을 쓴다(추가 비용 0):
 *   get_weekly_data   — 코드가 집계한 그 주 입력(스냅샷·이슈 근거·섹터·지표·일정) + 작성 규칙
 *   save_weekly_draft — 코멘트 문장만 받아 Gemini 와 같은 검증 → 코드가 본문 조립 → 초안(검토 대기) 저장
 * 발행·삭제·발행 취소 도구는 없다 — 발행은 오너가 /weekly 화면에서만.
 *
 * 전송: MCP Streamable HTTP 의 상태 없는(stateless) 형태 — POST 한 번에 JSON-RPC 응답 하나,
 * 세션·SSE 없음(GET 은 405). 외부 라이브러리 없이 필요한 메서드만 처리한다.
 *
 * 인증: 비밀 토큰 `WEEKLY_MCP_TOKEN`(1호기 app.env, 32자 이상). claude.ai 커넥터는 임의 헤더를
 * 넣기 어려워 주소 경로(`/api/mcp/<토큰>`)로 받고, 헤더(`Authorization: Bearer`)도 받는다.
 * 값이 없으면 503(fail-closed). 앱 로그인(Clerk)은 Anthropic 서버에서 올 수 없어 쓰지 않는다.
 */

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

export function mcpTokenStatus(given: string | null | undefined): "ok" | "unconfigured" | "denied" {
  const expected = process.env.WEEKLY_MCP_TOKEN ?? "";
  if (expected.length < 32) return "unconfigured";
  if (!given) return "denied";
  return timingSafeEqual(digest(given), digest(expected)) ? "ok" : "denied";
}

const WEEK_START = {
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}$",
  description: "대상 주 월요일(YYYY-MM-DD). 생략하면 지난주(직전 월~금). 지난 8주 안만.",
};

const TOOLS = [
  {
    name: "get_weekly_data",
    title: "주간 리포트 입력 조회",
    description:
      "주간 거시·시황 리포트 초안에 쓸 그 주 데이터를 돌려준다. 코드가 집계한 시장 스냅샷(표에 찍히는 값 그대로), " +
      "핵심 이슈 3개와 근거(증권사 리포트 제목·요약 발췌·PDF 링크, 뉴스), 금리정책·경제 근거, 상승·하락 상위 섹터와 " +
      "주도 종목 기사, 그 주 새로 발표된 미국 공식 지표, 다음 주 일정, 중앙은행 회의 일정. guide 에 작성 규칙이 있다 — " +
      "반드시 읽고 따른다. 조회만 하고 아무것도 바꾸지 않는다(보관본이 없을 때만 새로 수집, 최대 1~2분).",
    inputSchema: {
      type: "object",
      properties: {
        weekStart: WEEK_START,
        refresh: { type: "boolean", description: "보관본을 무시하고 다시 수집(보통 불필요)" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "save_weekly_draft",
    title: "주간 리포트 초안 저장(검토 대기)",
    description:
      "해석 문장만 받아 초안을 저장한다. 표·숫자·구조는 서버 코드가 만들고, 문장은 검증한다(근거 없는 수치·회의 없는 달 언급은 " +
      "그 칸만 버림). 저장된 초안은 /weekly 화면에서 오너가 검토·수정·발행한다 — 이 도구는 발행·삭제를 못 한다. " +
      "발행된 주나 오너가 고친 초안은 덮어쓰지 않는다. preview:true 면 저장 없이 완성 본문과 버려진 칸(dropped)만 돌려준다. " +
      "키는 get_weekly_data 의 data 값을 그대로 쓴다.",
    inputSchema: {
      type: "object",
      properties: {
        weekStart: WEEK_START,
        preview: { type: "boolean", description: "true 면 저장하지 않고 결과만 확인" },
        headline: { type: "string", description: "1. 한 줄 결론(120자 내외)" },
        economySummary: { type: "string", description: "5. 경제 — 주제별 '- 주제: …' 줄들" },
        policySummary: { type: "string", description: "6. 금리정책 — 은행별 '- 미국 연준(Fed): …' 줄들" },
        calendar: {
          type: "array",
          description: "7. 다음 주 일정(data.nextWeek 기간, 확인된 것만). sources 가 있을 때만 반영",
          items: {
            type: "object",
            properties: { date: { type: "string" }, event: { type: "string" } },
            required: ["date", "event"],
          },
        },
        snapshot: {
          type: "object",
          description: "스냅샷 자산별 코멘트 — 키 = data.snapshot[].name, 40~60자",
          additionalProperties: { type: "string" },
        },
        issues: {
          type: "object",
          description: "핵심 이슈 — 키 = data.issues[].label, 값 = {headline, reading}",
          additionalProperties: {
            type: "object",
            properties: { headline: { type: "string" }, reading: { type: "string" } },
            required: ["reading"],
          },
        },
        sectors: {
          type: "object",
          description: "섹터 사유 — 키 = data.sectors[].id, 주도 종목 기사(headlines) 근거로만",
          additionalProperties: { type: "string" },
        },
        sources: {
          type: "array",
          description: "웹검색으로 확인한 출처. 있으면 입력에 없는 수치도 인용 가능(없으면 그런 문장은 버려짐)",
          items: {
            type: "object",
            properties: { title: { type: "string" }, url: { type: "string" } },
            required: ["url"],
          },
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
] as const;

type Json = Record<string, unknown>;
interface RpcReq {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Json;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const MAX_TEXT = 4_000;

function clip(v: unknown): string | undefined {
  const s = str(v);
  return s == null ? undefined : s.slice(0, MAX_TEXT);
}

function strRecord(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v as Json).slice(0, 60)) if (typeof x === "string") out[k] = x.slice(0, MAX_TEXT);
  return out;
}

function toComments(a: Json): ConnectorComments {
  const issues: ConnectorComments["issues"] = {};
  if (a.issues && typeof a.issues === "object" && !Array.isArray(a.issues)) {
    for (const [k, x] of Object.entries(a.issues as Json).slice(0, 10)) {
      if (typeof x === "string") issues[k] = x.slice(0, MAX_TEXT);
      else if (x && typeof x === "object") {
        const o = x as Json;
        issues[k] = { headline: clip(o.headline), reading: clip(o.reading) };
      }
    }
  }
  const calendar = Array.isArray(a.calendar)
    ? a.calendar.slice(0, 40).map((c) => ({ date: str((c as Json)?.date), event: clip((c as Json)?.event) }))
    : undefined;
  return {
    headline: clip(a.headline),
    economySummary: clip(a.economySummary),
    policySummary: clip(a.policySummary),
    calendar,
    snapshot: strRecord(a.snapshot),
    issues,
    sectors: strRecord(a.sectors),
  };
}

function toSources(v: unknown): { title: string; url: string }[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => ({ title: str((x as Json)?.title) ?? "", url: str((x as Json)?.url) ?? "" }))
    .filter((x) => x.url);
}

async function callTool(name: string, args: Json): Promise<{ text: string; isError?: boolean }> {
  if (!isDbConfigured()) return { text: "서버 DB 미설정(MONGODB_URI)", isError: true };
  try {
    if (name === "get_weekly_data") {
      const out = await getConnectorData({ weekStart: str(args.weekStart), refresh: args.refresh === true });
      return { text: JSON.stringify(out) };
    }
    if (name === "save_weekly_draft") {
      const out = await saveConnectorDraft({
        weekStart: str(args.weekStart),
        comments: toComments(args),
        sources: toSources(args.sources),
        preview: args.preview === true,
      });
      const head = out.saved
        ? `저장됨 — ${out.weekStart} 주 초안(검토 대기). 오너가 /weekly 화면에서 검토·발행한다.`
        : `미리보기(저장 안 함) — ${out.weekStart} 주`;
      return { text: JSON.stringify({ result: head, dropped: out.dropped, body: out.body }) };
    }
    return { text: `알 수 없는 도구: ${name}`, isError: true };
  } catch (err) {
    if (err instanceof WeeklyGenerateError) return { text: err.message, isError: true };
    console.error("[mcp-weekly] 도구 실행 실패", name, err);
    return { text: `도구 실행 실패: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

async function handleOne(req: RpcReq): Promise<Json | null> {
  const id = req.id ?? null;
  const isNotification = req.id === undefined;
  const ok = (result: Json) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

  switch (req.method) {
    case "initialize": {
      const asked = str(req.params?.protocolVersion);
      return ok({
        protocolVersion: asked && SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "macro-weekly-report", version: "1.0.0" },
        instructions:
          "주간 거시·시황 리포트 초안 도구. get_weekly_data 로 데이터와 guide(작성 규칙)를 받고, 규칙대로 해석을 써서 " +
          "save_weekly_draft 로 저장한다(preview 로 먼저 확인 가능). 발행은 오너가 앱 화면에서 한다.",
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS as unknown as Json[] });
    case "tools/call": {
      const name = str(req.params?.name) ?? "";
      const args = (req.params?.arguments ?? {}) as Json;
      const r = await callTool(name, args);
      return ok({ content: [{ type: "text", text: r.text }], ...(r.isError ? { isError: true } : {}) });
    }
    default:
      if (isNotification) return null; // notifications/initialized 등 — 응답 없음
      return fail(-32601, `지원하지 않는 메서드: ${req.method}`);
  }
}

export async function handleMcpRequest(req: Request, token: string | null): Promise<Response> {
  const auth = mcpTokenStatus(token);
  if (auth === "unconfigured") return Response.json({ error: "커넥터 비활성(WEEKLY_MCP_TOKEN 미설정)" }, { status: 503 });
  if (auth === "denied") return Response.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON 파싱 실패" } }, { status: 400 });
  }
  const batch = Array.isArray(body);
  const reqs = (batch ? body : [body]) as RpcReq[];
  const out = (await Promise.all(reqs.slice(0, 20).map(handleOne))).filter((x): x is Json => x != null);
  if (out.length === 0) return new Response(null, { status: 202 });
  return Response.json(batch ? out : out[0], { headers: { "Cache-Control": "no-store" } });
}

export function mcpMethodNotAllowed(): Response {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
