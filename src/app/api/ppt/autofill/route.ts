import { jsonError, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/server/app-auth";
import { claudeFillConfig, fillCompany } from "@/lib/ppt/claude-fill";
import { monthSpendUsd } from "@/lib/ppt/store";

/**
 * 발표자료 「API 로 자동 채우기」(관리자만, 오너 2026-10-31 「나」 방식). 작성 화면(미구현)의 버튼이 부른다.
 *   GET  → 켜짐 여부·모델·월 상한·이번 달 추정 비용
 *   POST { symbols: ["kr:005930", ...], force?: boolean } → 종목마다 채우기(한 번에 최대 5종목 — 요청 시간 한도 안)
 * 키가 없으면 꺼짐(안내문), 월 상한이면 멈춤. 비었거나 오래된 종목만(force 가 아니면).
 */
export const maxDuration = 300;
const MAX_PER_REQUEST = 5;

export async function GET() {
  const who = await requireAdmin();
  if (!who.ok) return Response.json({ error: who.error }, { status: who.status });
  try {
    const cfg = claudeFillConfig();
    return ok({ ...cfg, monthSpendUsd: await monthSpendUsd() });
  } catch (err) {
    return jsonError(err);
  }
}

export async function POST(request: Request) {
  const who = await requireAdmin();
  if (!who.ok) return Response.json({ error: who.error }, { status: who.status });
  try {
    const cfg = claudeFillConfig();
    if (!cfg.enabled) return Response.json({ error: cfg.reason, enabled: false }, { status: 503 });
    const body = (await request.json()) as { symbols?: unknown; force?: unknown };
    const symbols = Array.isArray(body.symbols) ? body.symbols.filter((s): s is string => typeof s === "string") : [];
    const targets = symbols
      .map((s) => /^(kr|us|jp):([A-Za-z0-9.\-]{1,12})$/.exec(s))
      .filter((m): m is RegExpExecArray => m !== null)
      .slice(0, MAX_PER_REQUEST);
    if (!targets.length) return Response.json({ error: "symbols 예: [\"kr:005930\"]" }, { status: 400 });
    const results = [];
    for (const m of targets) {
      const r = await fillCompany(m[1] as "kr" | "us" | "jp", m[2], { by: who.email, force: body.force === true });
      results.push(r);
      if (r.status === "budget" || r.status === "disabled") break;
    }
    return ok({ results, monthSpendUsd: await monthSpendUsd() });
  } catch (err) {
    return jsonError(err);
  }
}
