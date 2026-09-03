import { z } from "zod";
import { jsonError } from "@/lib/api";
import { isMarketId, type MarketId } from "@/lib/markets/types";
import { getStockSlideData } from "@/lib/ppt/slide-data";
import { buildStockPptx } from "@/lib/ppt/slide";

export const maxDuration = 60;

const schema = z.object({
  market: z.enum(["kr", "us", "jp"]),
  symbol: z.string().min(1).max(20),
  yahoo: z.string().max(20).nullable().optional(),
  bullets: z.array(z.string().max(300)).max(6).optional(),
  priceYears: z.union([z.literal(1), z.literal(3), z.literal(5)]).optional(),
});

export async function POST(req: Request) {
  try {
    const b = schema.parse(await req.json());
    if (!isMarketId(b.market)) throw new Error("시장 오류");
    const data = await getStockSlideData(b.market as MarketId, b.symbol, {
      yahoo: b.yahoo ?? null,
      bullets: b.bullets,
      priceYears: b.priceYears,
    });
    const buf = await buildStockPptx([data]);
    const fname = `${b.market}_${data.symbol}_${data.asOf}.pptx`;
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
