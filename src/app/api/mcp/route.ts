import { handleMcpRequest, mcpMethodNotAllowed } from "@/lib/server/mcp-weekly";

// 주간 리포트 MCP 서버(claude.ai 커넥터) — 토큰은 Authorization: Bearer 헤더. 설명은 lib/server/mcp-weekly.ts
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
  return handleMcpRequest(req, m?.[1]?.trim() ?? null);
}

export const GET = mcpMethodNotAllowed;
export const DELETE = mcpMethodNotAllowed;
