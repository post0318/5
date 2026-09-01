import { ZodError } from "zod";
import { AdapterError } from "@/lib/markets/types";

export function jsonError(err: unknown): Response {
  if (err instanceof ZodError) {
    return Response.json(
      { error: "입력값 오류", issues: err.issues },
      { status: 400 },
    );
  }
  if (err instanceof AdapterError) {
    return Response.json({ error: err.message }, { status: err.opts.status ?? 502 });
  }
  console.error("[api] unexpected error", err);
  return Response.json({ error: "서버 오류" }, { status: 500 });
}

export function ok<T>(data: T, init?: ResponseInit): Response {
  return Response.json(data, init);
}
