import "server-only";
import { MongoClient, type Collection, type Db } from "mongodb";
import type { UniverseItemDoc } from "./schema";

/**
 * MongoDB 연결. 서버리스에서 인스턴스 간 커넥션 재사용 (globalThis 캐시).
 * MONGODB_URI 필요. DB 이름은 URI 에 없으면 `market_research`.
 */

const uri = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB ?? "market_research";

interface Cached {
  client: MongoClient | null;
  promise: Promise<MongoClient> | null;
}
const g = globalThis as unknown as { _mongo?: Cached };
const cached: Cached = g._mongo ?? (g._mongo = { client: null, promise: null });

async function getClient(): Promise<MongoClient> {
  if (!uri) throw new Error("MONGODB_URI 가 설정되지 않았습니다");
  if (cached.client) return cached.client;
  if (!cached.promise) {
    cached.promise = new MongoClient(uri, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 8000,
    }).connect();
  }
  cached.client = await cached.promise;
  return cached.client;
}

export function isDbConfigured(): boolean {
  return Boolean(uri);
}

export async function getDb(): Promise<Db> {
  return (await getClient()).db(DB_NAME);
}

export async function universeCol(): Promise<Collection<UniverseItemDoc>> {
  const db = await getDb();
  const col = db.collection<UniverseItemDoc>("universe_items");
  // 소유자+시장+심볼 유니크 인덱스 (idempotent). 계정별 유니버스 분리 이후
  // 같은 종목을 여러 사람이 담을 수 있어야 하므로 ownerId 가 키에 들어간다.
  // 옛 (market, symbol) 유니크 인덱스가 남아 있으면 A·B 가 같은 종목을 담을 때
  // 충돌하므로 먼저 걷어낸다(없으면 조용히 무시).
  await col.dropIndex("market_1_symbol_1").catch(() => {});
  await col
    .createIndex({ ownerId: 1, market: 1, symbol: 1 }, { unique: true })
    .catch(() => {});
  return col;
}
