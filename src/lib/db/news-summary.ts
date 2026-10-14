import "server-only";
import { createHash } from "node:crypto";
import type { Collection } from "mongodb";
import { getDb, isDbConfigured } from "./index";

/**
 * 해외 시황 뉴스 요약 저장(2026-10-14, post0318/4 의 Redis `news:sum:` 을 MongoDB 로 옮김).
 * 예약 작업(`/api/cron/news-summary`)이 쓰고, 목록 제목·팝업이 읽는다. 기사 1건 = 문서 1건(_id = 목록 url 해시).
 * 30일 지나면 TTL 로 지운다 — 목록은 최근 1주일 기사만이라 충분하다.
 */
export type SummaryBasis = "article" | "other" | "link";

export interface NewsSummaryDoc {
  _id: string;
  /** 목록 항목 url(NewsItem.url — Google 뉴스 링크일 수 있다) */
  link: string;
  title: string;
  titleKo: string;
  /** 비어 있으면 "본문을 읽을 수 없었다"로 확정(다른 매체까지 시도한 뒤) */
  bullets: string[];
  /** 실제 원문 URL(디코딩 성공 시) */
  url: string;
  basis: SummaryBasis;
  sources?: { url: string; source: string }[];
  model: string;
  /** 지시문 버전(SUMMARY_VERSION) — 올리면 옛 저장본을 다시 만든다 */
  v: number;
  createdAt: Date;
}

const TTL_DAYS = 30;

export const summaryKey = (link: string) => createHash("sha1").update(link).digest("hex").slice(0, 24);

let indexed = false;
export async function newsSummaryCol(): Promise<Collection<NewsSummaryDoc>> {
  const db = await getDb();
  const col = db.collection<NewsSummaryDoc>("news_summary");
  if (!indexed) {
    indexed = true;
    await col.createIndex({ createdAt: 1 }, { expireAfterSeconds: TTL_DAYS * 86400 }).catch(() => {});
  }
  return col;
}

/** 목록 url 들의 저장본 — url → 문서. DB 가 없거나 장애면 빈 맵(목록은 무료 번역 그대로) */
export async function getNewsSummaries(links: string[]): Promise<Map<string, NewsSummaryDoc>> {
  const out = new Map<string, NewsSummaryDoc>();
  if (!links.length || !isDbConfigured()) return out;
  try {
    const col = await newsSummaryCol();
    const docs = await col.find({ _id: { $in: links.map(summaryKey) } }).toArray();
    for (const d of docs) out.set(d.link, d);
  } catch (e) {
    console.warn("[news-summary] 조회 실패", e instanceof Error ? e.message : e);
  }
  return out;
}

export async function saveNewsSummary(doc: Omit<NewsSummaryDoc, "_id" | "createdAt">): Promise<void> {
  const col = await newsSummaryCol();
  await col.replaceOne({ _id: summaryKey(doc.link) }, { ...doc, createdAt: new Date() }, { upsert: true });
}
