import { jsonError, ok } from "@/lib/api";
import { getAdapter } from "@/lib/markets/registry";
import { isMarketId } from "@/lib/markets/types";
import { isAllowedArticle, isDomesticPublisher, fetchArticleBody } from "@/lib/markets/news";
import { urlHash, saveNewsSummary, deleteNewsSummary } from "@/lib/db/news-saved";
import { isBudgetExceeded, incUsage, claimAlertSlot, getMonthUsage } from "@/lib/db/llm-usage";
import { summarizeArticle } from "@/lib/llm/claude";
import { sendBudgetAlert } from "@/lib/email/resend";

export const maxDuration = 60;

interface SummarizeBody {
  url: string;
  title: string;
  publisher: string;
  publishedAt: string;
}

/**
 * 체크한 기사 1건 번역(필요시)·요약·진위판단 → news_saved 저장. LLM 비용 발생
 * — proxy.ts 매처로 로그인 필요. 월 $10 상한 도달 시 429 + (최초 1회) 이메일.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ market: string; symbol: string }> },
) {
  try {
    const { market, symbol } = await params;
    if (!isMarketId(market)) {
      return Response.json({ error: "알 수 없는 시장" }, { status: 404 });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return Response.json(
        { error: "번역·요약 기능이 아직 설정되지 않았습니다 (ANTHROPIC_API_KEY 미등록)" },
        { status: 503 },
      );
    }
    const body = (await request.json()) as Partial<SummarizeBody>;
    if (!body.url || !body.title || !body.publisher || !body.publishedAt) {
      return Response.json({ error: "잘못된 요청" }, { status: 400 });
    }
    // 서버가 다시 검증 — 클라이언트값 신뢰 안 함
    if (!isAllowedArticle(body.publisher, body.publishedAt)) {
      return Response.json({ error: "화이트리스트·기간 조건에 맞지 않는 기사입니다" }, { status: 400 });
    }
    // 국내(이미 한국어) 언론사 기사는 번역·요약 불필요 — 체크박스 자체를 안 보여줌(UI),
    // 서버도 방어적으로 거부. (종목의 상장 시장이 아니라 기사 언론사 기준 — 한국
    // 종목의 해외(로이터 등) 보도는 통과되어야 함)
    if (isDomesticPublisher(body.publisher)) {
      return Response.json({ error: "국내 기사는 번역·요약 대상이 아닙니다" }, { status: 400 });
    }

    if (await isBudgetExceeded()) {
      const usage = await getMonthUsage();
      if (await claimAlertSlot()) {
        await sendBudgetAlert(usage._id, usage.totalCostUsd);
      }
      return Response.json(
        { error: "이번 달 번역·요약 예산을 초과했습니다. 다음 달에 다시 시도해주세요." },
        { status: 429 },
      );
    }

    const sym = getAdapter(market).normalizeSymbol(decodeURIComponent(symbol));
    const bodyText = await fetchArticleBody(body.url).catch(() => "");
    if (!bodyText) {
      return Response.json({ error: "기사 본문을 가져오지 못했습니다" }, { status: 502 });
    }

    const result = await summarizeArticle({
      title: body.title,
      bodyText,
      publisher: body.publisher,
      needsTranslation: true, // 위에서 국내(한국어) 언론사를 걸러내 항상 외국어 기사만 남음
    });
    await incUsage(result.costUsd);

    if (!result.isLikelyGenuine) {
      return Response.json(
        { error: `진위 확인 실패 — ${result.reason || "정상 보도로 판단되지 않습니다"}` },
        { status: 422 },
      );
    }

    await saveNewsSummary({
      _id: urlHash(body.url),
      market,
      symbol: sym,
      title: body.title,
      publisher: body.publisher,
      url: body.url,
      publishedAt: body.publishedAt,
      translatedTitle: result.translatedTitle,
      translatedText: result.translatedText,
      summary: result.summary,
      createdAt: new Date().toISOString(),
    });

    return ok({ saved: true });
  } catch (err) {
    return jsonError(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const url = new URL(request.url).searchParams.get("url");
    if (!url) return Response.json({ error: "url 파라미터 필요" }, { status: 400 });
    await deleteNewsSummary(url);
    return ok({ deleted: true });
  } catch (err) {
    return jsonError(err);
  }
}
