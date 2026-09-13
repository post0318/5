import { jsonError, ok } from "@/lib/api";
import { loadInfluencers } from "@/lib/influencers/store";

// influencers.md 는 배포마다(또는 수정마다) 바뀔 수 있는 정적 파일 — 짧게 캐시
export const revalidate = 300;

export async function GET() {
  try {
    const items = await loadInfluencers();
    return ok({
      items: items.map((i) => ({
        id: i.id,
        name: i.name,
        hasBlog: Boolean(i.blogUrl),
        hasYoutube: Boolean(i.youtubeUrl),
        hasTelegram: Boolean(i.telegramUrl),
      })),
    });
  } catch (err) {
    return jsonError(err);
  }
}
