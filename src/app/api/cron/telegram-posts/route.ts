import { jsonError, ok } from "@/lib/api";
import { isDbConfigured } from "@/lib/db";
import { upsertTelegramPosts, type TelegramPostDoc } from "@/lib/db/telegram-posts";

export const maxDuration = 60;

/**
 * 텔레그램 채널 게시물 수집 수신처 — scripts/collect-telegram-posts.mjs(로컬
 * 전용, 개인 계정 세션 사용)가 쓴다. 이 라우트 자체는 텔레그램에 접속하지
 * 않는다 — 로컬에서 이미 수집된 결과를 받아 DB에 적재만 한다(배포된 앱은
 * DB 조회만 함, 다른 리서치 소스와 동일 원칙, 2026-09).
 */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const appPw = process.env.APP_PASSWORD;
  if (appPw && req.headers.get("x-app-token") === appPw) return true;
  if (secret) return req.headers.get("authorization") === `Bearer ${secret}`;
  return false;
}

interface RawItem {
  messageId: string;
  text: string;
  publishedAt: string;
}

export async function POST(req: Request) {
  try {
    if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (!isDbConfigured()) return Response.json({ error: "MONGODB_URI 미설정" }, { status: 503 });

    const body = (await req.json()) as {
      channelUsername?: string;
      channelTitle?: string;
      items?: RawItem[];
    };
    const channelUsername = body.channelUsername?.trim();
    const channelTitle = body.channelTitle?.trim() || channelUsername || "";
    if (!channelUsername) return Response.json({ error: "channelUsername 필요" }, { status: 400 });
    if (!Array.isArray(body.items)) return Response.json({ error: "items 배열 필요" }, { status: 400 });

    const now = new Date().toISOString();
    const docs: TelegramPostDoc[] = body.items.map((it) => ({
      _id: `${channelUsername}:${it.messageId}`,
      channelUsername,
      channelTitle,
      text: it.text,
      link: `https://t.me/${channelUsername}/${it.messageId}`,
      publishedAt: it.publishedAt,
      collectedAt: now,
    }));

    const result = await upsertTelegramPosts(docs);
    return ok({ channelUsername, received: docs.length, ...result });
  } catch (err) {
    return jsonError(err);
  }
}
