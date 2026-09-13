import { jsonError, ok } from "@/lib/api";
import { getInfluencer } from "@/lib/influencers/store";
import { fetchNaverBlogPosts } from "@/lib/influencers/naver-blog";
import { fetchYoutubeVideos } from "@/lib/influencers/youtube";
import { getTelegramFeed } from "@/lib/influencers/telegram";

export const revalidate = 900;
export const maxDuration = 20;

interface FeedItem {
  platform: "blog" | "youtube" | "telegram";
  title: string;
  link: string;
  publishedAt: string;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const inf = await getInfluencer(id);
    if (!inf) return Response.json({ error: "존재하지 않는 인플루언서" }, { status: 404 });

    const [posts, videos, telegramPosts] = await Promise.all([
      inf.blogUrl ? fetchNaverBlogPosts(inf.blogUrl) : Promise.resolve([]),
      inf.youtubeUrl ? fetchYoutubeVideos(inf.youtubeUrl) : Promise.resolve([]),
      inf.telegramUrl ? getTelegramFeed(inf.telegramUrl) : Promise.resolve([]),
    ]);
    const items: FeedItem[] = [
      ...posts.map((p) => ({ platform: "blog" as const, ...p })),
      ...videos.map((v) => ({ platform: "youtube" as const, ...v })),
      ...telegramPosts.map((t) => ({ platform: "telegram" as const, ...t })),
    ];

    items.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    return ok({ items });
  } catch (err) {
    return jsonError(err);
  }
}
