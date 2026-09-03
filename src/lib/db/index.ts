import "server-only";
import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "./schema";

/**
 * 로컬 개인용: file: URL 의 libSQL(SQLite).
 * 배포(Vercel 등): DATABASE_URL 을 Turso(libsql://) 로, DATABASE_AUTH_TOKEN 설정.
 *
 * 지연 초기화 — DB 미설정 환경에서도 DB를 쓰지 않는 라우트는 정상 동작.
 */
let _db: LibSQLDatabase<typeof schema> | null = null;
let _client: Client | null = null;

function init() {
  const url = process.env.DATABASE_URL ?? "file:./data/app.db";
  const authToken = process.env.DATABASE_AUTH_TOKEN;
  _client = createClient({ url, ...(authToken ? { authToken } : {}) });
  _db = drizzle(_client, { schema });
}

export const db = new Proxy({} as LibSQLDatabase<typeof schema>, {
  get(_t, prop, receiver) {
    if (!_db) init();
    return Reflect.get(_db as object, prop, receiver);
  },
});

export { schema };
