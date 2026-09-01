import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * 유니버스 종목 (prd.md §5.4)
 * 개인용: 로컬 SQLite(libSQL). 확장 시 Postgres로 스키마 이식.
 */
export const universeItems = sqliteTable(
  "universe_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** "kr" | "us" | "jp" */
    market: text("market").notNull(),
    /** 시장별 정규화 심볼 (한국 6자리, 미국 티커, 일본 코드) */
    symbol: text("symbol").notNull(),
    /** 표시용 이름 (선택) */
    name: text("name"),
    /** Yahoo 심볼 오버라이드 (KOSDAQ는 .KQ 등) */
    yahooSymbol: text("yahoo_symbol"),
    /** 분류 그룹 (예: 반도체, 코어) */
    groupName: text("group_name"),
    /** 태그 목록 (JSON 문자열 배열) */
    tags: text("tags", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    /** 활성/비활성 토글 */
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    note: text("note"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (t) => [uniqueIndex("uq_market_symbol").on(t.market, t.symbol)],
);

export type UniverseItem = typeof universeItems.$inferSelect;
export type NewUniverseItem = typeof universeItems.$inferInsert;
