import { jsonError, ok } from "@/lib/api";
import { isDbConfigured } from "@/lib/db";
import { getKrFearGreed } from "@/lib/macro/kr/fear-greed";

// 2분. 데이터는 하루 1회 갱신이지만, 배포·데이터 정정 후 결과가 30분씩
// 옛 캐시로 남던 문제가 반복돼 짧게 잡음. 계산 자체는 가벼움(Mongo 읽기 + 산술).
export const revalidate = 120;

export async function GET() {
  try {
    if (!isDbConfigured()) return ok({ krFearGreed: null, reason: "DB 미설정" });
    const krFearGreed = await getKrFearGreed().catch(() => null);
    return ok({ krFearGreed });
  } catch (err) {
    return jsonError(err);
  }
}
