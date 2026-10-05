import "server-only";
import type { Collection } from "mongodb";
import { getDb } from "./index";

/**
 * 인플루언서 네이버 블로그 새 글(제목·링크·발행시각만 — 본문 저장 금지). 2026-10-05 오너 지시: 화면을 열 때마다
 * rss.blog.naver.com 을 부르면 차단 위험이 있어, 오라클 타이머 `news-naver-blog`(5분)가 RSS 를 확인해 **새 글만** 여기 넣고
 * 화면은 이 컬렉션만 읽는다. `_id` = 추적 파라미터를 뗀 글 링크(이미 있으면 무시 — insert only).
 * 보존: `expireAt` TTL 인덱스(180일, 유튜브 영상과 같음). 예상 용량 약 6건/일 × 180일 × ~0.4KB ≈ 0.5MB.
 */
export interface NaverBlogPostDoc {
  _id: string; // 글 링크
  blogId: string;
  title: string;
  publishedAt: string; // ISO
  collectedAt: string; // ISO
  expireAt: Date; // TTL 기준
}

const TTL_SECONDS = 180 * 24 * 3600;

export async function naverBlogPostsCol(): Promise<Collection<NaverBlogPostDoc>> {
  const col = (await getDb()).collection<NaverBlogPostDoc>("naver_blog_posts");
  await col.createIndex({ blogId: 1, publishedAt: -1 }).catch(() => {});
  await col.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }).catch(() => {});
  return col;
}

/** 새 글만 저장(이미 있는 링크는 건드리지 않음). 새로 들어간 개수를 돌려준다. */
export async function insertNewNaverBlogPosts(
  posts: { blogId: string; title: string; link: string; publishedAt: string }[],
): Promise<number> {
  if (!posts.length) return 0;
  const col = await naverBlogPostsCol();
  const now = new Date();
  const r = await col.bulkWrite(
    posts.map((p) => ({
      updateOne: {
        filter: { _id: p.link },
        update: {
          $setOnInsert: {
            blogId: p.blogId,
            title: p.title,
            publishedAt: p.publishedAt,
            collectedAt: now.toISOString(),
            expireAt: new Date(now.getTime() + TTL_SECONDS * 1000),
          },
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );
  return r.upsertedCount;
}

export async function getNaverBlogPostsByBlog(blogId: string, limit = 10): Promise<NaverBlogPostDoc[]> {
  const col = await naverBlogPostsCol();
  return col.find({ blogId }).sort({ publishedAt: -1 }).limit(limit).toArray();
}
