// DB 용량 측정 — 컬렉션별 데이터·저장·인덱스 크기(무료 등급 512MB 한도 관리, 오너 지시 2026-09-26 "db 용량 반드시 고려")
// 사용: node scripts/db/size.mjs   (읽기 전용 — collStats 만 호출)
import { MongoClient } from "mongodb";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local", quiet: true });
const c = new MongoClient(process.env.MONGODB_URI);
await c.connect();
const db = c.db(process.env.MONGODB_DB || "market_research");
const st = await db.stats();
console.log(`한도 512MB 대비 ${(((st.dataSize + st.indexSize) / 1048576) / 512 * 100).toFixed(1)}% · DB ${db.databaseName}: data ${(st.dataSize/1048576).toFixed(1)}MB · storage ${(st.storageSize/1048576).toFixed(1)}MB · index ${(st.indexSize/1048576).toFixed(1)}MB`);
const rows = [];
for (const col of await db.listCollections().toArray()) {
  const s = await db.command({ collStats: col.name }).catch(() => null);
  if (s) rows.push([col.name, s.count, s.size, s.storageSize, s.totalIndexSize]);
}
rows.sort((a, b) => b[2] - a[2]);
for (const r of rows) console.log(r[0].padEnd(28), String(r[1]).padStart(7), "docs", (r[2]/1048576).toFixed(2).padStart(7), "MB data", (r[3]/1048576).toFixed(2).padStart(7), "MB stor", (r[4]/1048576).toFixed(2).padStart(6), "MB idx");
await c.close();
