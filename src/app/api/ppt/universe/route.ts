import { z } from "zod";
import { jsonError } from "@/lib/api";
import { isMarketId, type MarketId } from "@/lib/markets/types";
import { listUniverse } from "@/lib/universe/repo";
import { getStockSlideData } from "@/lib/ppt/slide-data";
import { buildStockPptx } from "@/lib/ppt/slide";

export const maxDuration = 300;

const schema = z.object({
  market: z.enum(["kr", "us", "jp"]),
  ids: z.array(z.string()).max(60).optional(),
});

export async function POST(req: Request) {
  try {
    const { market, ids } = schema.parse(await req.json());
    if (!isMarketId(market)) throw new Error("시장 오류");

    let items = await listUniverse({ market: market as MarketId, activeOnly: true });
    if (ids?.length) items = items.filter((i) => ids.includes(i.id));
    if (items.length === 0) throw new Error("대상 종목이 없습니다");

    // note 필드를 회사 개요로 사용 (첫 줄 = 개요, 나머지 = 주요 사업)
    const slides = [];
    for (const it of items) {
      try {
        const noteLines = (it.note ?? "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
        slides.push(
          await getStockSlideData(it.market as MarketId, it.symbol, {
            yahoo: it.yahooSymbol,
            overview: noteLines[0] ?? "",
            business: noteLines.slice(1),
          }),
        );
      } catch {
        // 개별 종목 실패는 건너뜀
      }
    }
    if (slides.length === 0) throw new Error("슬라이드 생성 실패");

    const buf = await buildStockPptx(slides);
    const fname = `universe_${market}_${new Date().toISOString().slice(0, 10)}.pptx`;
    return new Response(new Uint8Array(buf), {
      headers: {
        "content-type":
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "content-disposition": `attachment; filename="${fname}"`,
      },
    });
  } catch (err) {
    return jsonError(err);
  }
}
