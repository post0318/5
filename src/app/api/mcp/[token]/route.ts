import { handleMcpRequest, mcpMethodNotAllowed } from "@/lib/server/mcp-weekly";

// 주간 리포트 MCP 서버(claude.ai 커넥터) — claude.ai 는 임의 헤더를 넣기 어려워 토큰을 주소 경로로 받는다.
// 설명은 lib/server/mcp-weekly.ts
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return handleMcpRequest(req, token);
}

export const GET = mcpMethodNotAllowed;
export const DELETE = mcpMethodNotAllowed;
