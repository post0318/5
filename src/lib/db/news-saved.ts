import "server-only";
import { createHash } from "node:crypto";
import type { Collection } from "mongodb";
import { getDb } from "./index";
import type { MarketId } from "../markets/types";

/**
 * 종목뉴스 선택 번역·요약 — 사용자가 체크한 기사만 저장 (전체 자동 저장 아님).
 * 미국·일본만 대상 (한국은 기존 딥링크 유지, 이 컬렉션에 안 들어감).
 */
export interface NewsSavedDoc {
  _id: string; // sha256(url)
  market: MarketId;
  symbol: string;
  title: string;
  publisher: string;
  url: string;
  publishedAt: string; // ISO
  translatedTitle: string;
  translatedText: string;
  summary: string;
  createdAt: string;
}

export function urlHash(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

export async function newsSavedCol(): Promise<Collection<NewsSavedDoc>> {
  const db = await getDb();
  const col = db.collection<NewsSavedDoc>("news_saved");
  await col.createIndex({ market: 1, symbol: 1 }).catch(() => {});
  return col;
}

export async function getSavedNews(market: MarketId, symbol: string): Promise<NewsSavedDoc[]> {
  const col = await newsSavedCol();
  return col.find({ market, symbol }).sort({ publishedAt: -1 }).toArray();
}

/** 이 종목 기사들 중 이미 저장된 url 집합 (목록 화면 체크 상태 표시용). */
export async function getSavedUrlSet(market: MarketId, symbol: string): Promise<Set<string>> {
  const docs = await getSavedNews(market, symbol);
  return new Set(docs.map((d) => d.url));
}

export async function saveNewsSummary(doc: NewsSavedDoc): Promise<void> {
  const col = await newsSavedCol();
  await col.replaceOne({ _id: doc._id }, doc, { upsert: true });
}

export async function deleteNewsSummary(url: string): Promise<void> {
  const col = await newsSavedCol();
  await col.deleteOne({ _id: urlHash(url) });
}
