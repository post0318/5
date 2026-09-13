import "server-only";
import { isDbConfigured } from "@/lib/db";
import { getTelegramPostsByChannel } from "@/lib/db/telegram-posts";

/**
 * 텔레그램은 (다른 플랫폼과 달리) 배포 앱에서 실시간으로 접속하지 않는다 —
 * 개인 계정 세션이 필요해서 로컬 수집기(scripts/collect-telegram-posts.mjs)가
 * 미리 모아둔 DB(telegram_posts)를 읽기만 한다.
 */

export interface TelegramPost {
  title: string;
  link: string;
  publishedAt: string;
}

export function telegramUsername(telegramUrl: string): string | null {
  const m = telegramUrl.match(/t\.me\/([\w.]+)/i);
  return m ? m[1] : null;
}

export async function getTelegramFeed(telegramUrl: string, limit = 10): Promise<TelegramPost[]> {
  if (!isDbConfigured()) return [];
  const username = telegramUsername(telegramUrl);
  if (!username) return [];
  try {
    const posts = await getTelegramPostsByChannel(username, limit);
    return posts.map((p) => ({
      // 텔레그램 글은 제목이 없는 경우가 많아 본문 첫 줄을 제목처럼 사용
      title: p.text.split("\n")[0].slice(0, 120) || "(내용 없음)",
      link: p.link,
      publishedAt: p.publishedAt,
    }));
  } catch {
    return [];
  }
}
