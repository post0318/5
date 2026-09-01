import "server-only";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";

/**
 * 로컬 개인용: file: URL 의 libSQL(SQLite).
 * 확장 시 DATABASE_URL 을 Turso/Postgres 로 바꾸고 드라이버 교체.
 */
const url = process.env.DATABASE_URL ?? "file:./data/app.db";
const authToken = process.env.DATABASE_AUTH_TOKEN;

const client = createClient({ url, ...(authToken ? { authToken } : {}) });

export const db = drizzle(client, { schema });
export { schema };
