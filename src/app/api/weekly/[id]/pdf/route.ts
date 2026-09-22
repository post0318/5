import { jsonError } from "@/lib/api";
import { isDbConfigured } from "@/lib/db";
import { getWeeklyReport } from "@/lib/db/weekly-reports";
import { authErrorResponse, requireAppUser } from "@/lib/server/app-auth";
import { generateWeeklyReportPdf, isPdfExportConfigured } from "@/lib/weekly/pdf";

const ID_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 주간 리포트 PDF 다운로드(오너 지시 2026-09-22). 외부 API(PDFShift) 경유
 * 라 이 함수 자체는 가벼움 — 응답을 기다리는 동안만 실행 시간이 걸린다.
 */
export const maxDuration = 45;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    // 발행 화면과 같은 인증 — 로그인 계정만(PATCH 라우트와 동일 정책).
    const who = await requireAppUser();
    if (!who.ok) return authErrorResponse(who);

    const { id } = await params;
    if (!ID_RE.test(id)) return Response.json({ error: "잘못된 id" }, { status: 400 });
    if (!isDbConfigured()) return Response.json({ error: "MONGODB_URI 미설정" }, { status: 503 });
    if (!isPdfExportConfigured()) {
      return Response.json(
        { error: "PDFSHIFT_API_KEY 미설정 — pdfshift.io 가입 후 발급받은 키를 등록하세요" },
        { status: 503 },
      );
    }

    const doc = await getWeeklyReport(id);
    if (!doc) return Response.json({ error: "없음" }, { status: 404 });

    const pdf = await generateWeeklyReportPdf(doc);
    return new Response(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="weekly-${doc._id}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return jsonError(err);
  }
}
