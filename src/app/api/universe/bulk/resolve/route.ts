import { z } from "zod";
import { jsonError, ok } from "@/lib/api";
import {
  BULK_MAX_FILE_BYTES,
  parseBulkFile,
  parsePastedText,
  type BulkInputResult,
} from "@/lib/universe/bulk-input";
import { resolveBulkEntries } from "@/lib/universe/resolve";
import { authErrorResponse, requireAppUser } from "@/lib/server/app-auth";

export const maxDuration = 60;

/**
 * 일괄 업로드 미리보기 — 붙여넣은 글 또는 파일(.xlsx·.csv·.txt)을 행으로 나누고
 * 행마다 종목을 해석해 돌려준다. DB 에는 쓰지 않는다(저장은 `/api/universe/bulk`).
 */
const schema = z
  .object({
    text: z.string().max(100_000).optional(),
    file: z
      .object({
        name: z.string().min(1).max(200),
        // base64 — 1MB 파일이면 약 1.34MB 글자
        base64: z.string().max(Math.ceil((BULK_MAX_FILE_BYTES * 4) / 3) + 8),
      })
      .optional(),
    defaultMarket: z.enum(["kr", "us", "jp"]).optional(),
  })
  .refine((v) => Boolean(v.text?.trim()) !== Boolean(v.file), {
    message: "붙여넣은 글 또는 파일 중 하나만 보내 주세요",
  });

export async function POST(request: Request) {
  try {
    const who = await requireAppUser();
    if (!who.ok) return authErrorResponse(who);

    const body = schema.parse(await request.json());
    let input: BulkInputResult;
    try {
      input = body.file
        ? parseBulkFile(body.file.name, new Uint8Array(Buffer.from(body.file.base64, "base64")))
        : parsePastedText(body.text ?? "");
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 400 });
    }
    if (input.entries.length === 0) {
      return Response.json({ error: "읽을 종목이 없습니다" }, { status: 400 });
    }
    const rows = await resolveBulkEntries(input.entries, body.defaultMarket);
    return ok({ rows, notices: input.notices }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return jsonError(err);
  }
}
