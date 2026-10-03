import { jsonError, ok } from "@/lib/api";
import { loadInfluencers } from "@/lib/influencers/store";

// influencers.md 는 배포마다(또는 수정마다) 바뀔 수 있는 정적 파일 — 짧게 캐시
// 빌드 때 미리 만들지 않는다 — 빌드 시점엔 DB 가 없어 DB 항목이 빈 결과가 배포·재부팅 직후 첫 화면으로 나갔다(2026-10-04 실측). 외부 조회는 각 모듈 내부 캐시가 맡는다.
export const dynamic = "force-dynamic";

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
