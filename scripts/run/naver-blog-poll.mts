/**
 * 인플루언서 네이버 블로그 새 글 수집 — 오라클 타이머 `news-naver-blog`(5분마다, 2026-10-05 오너 지시)가 run-ts.sh 로 실행한다.
 * influencers.md 의 blog 항목마다 RSS 1요청 → 새 글만 DB(naver_blog_posts)에 넣는다(링크 기준, 이미 있으면 무시). 텔레그램 알림 없음.
 * 실패(HTTP 오류·RSS 아님·항목 0건)는 로그에 남기고 종료코드 1 — 다른 블로그는 계속 처리한다.
 *
 * 실행: NODE_OPTIONS=--conditions=react-server npx -y tsx@4.23.15 --tsconfig tsconfig.json scripts/run/naver-blog-poll.mts [--dry]
 *   --dry : RSS 파싱 결과만 출력하고 DB 에 쓰지 않는다(로컬·운영이 같은 DB 라 로컬 확인용)
 * 필요한 환경변수: MONGODB_URI(--dry 가 아니면 필수)
 */
import { isDbConfigured } from "@/lib/db";
import { insertNewNaverBlogPosts } from "@/lib/db/naver-blog-posts";
import { loadInfluencers } from "@/lib/influencers/store";
import { naverBlogId, parseNaverBlogRss } from "@/lib/influencers/naver-blog";

async function main() {
  const dry = process.argv.includes("--dry");
  if (!dry && !isDbConfigured()) throw new Error("MONGODB_URI 미설정");
  const blogIds = [
    ...new Set((await loadInfluencers()).map((i) => (i.blogUrl ? naverBlogId(i.blogUrl) : null)).filter((x): x is string => !!x)),
  ];
  console.log(`대상 블로그 ${blogIds.length}곳${dry ? " (저장 안 함)" : ""}`);
  let failed = 0;
  for (const blogId of blogIds) {
    try {
      const res = await fetch(`https://rss.blog.naver.com/${blogId}.xml`, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; stock-research/1.0)" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const xml = await res.text();
      if (!xml.includes("<rss")) throw new Error("RSS 아닌 응답(차단 의심)");
      const posts = parseNaverBlogRss(xml);
      if (!posts.length) throw new Error("RSS 항목 0건");
      const latest = posts.reduce((a, b) => (a.publishedAt > b.publishedAt ? a : b));
      if (dry) {
        console.log(`${blogId}: ${posts.length}건 · 최신 ${latest.publishedAt} · ${latest.title}`);
        continue;
      }
      const added = await insertNewNaverBlogPosts(posts.map((p) => ({ blogId, ...p })));
      console.log(`${blogId}: RSS ${posts.length}건 중 새 글 ${added}건 · 최신 ${latest.publishedAt}`);
    } catch (e) {
      failed++;
      console.error(`${blogId}: 실패 — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (failed) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode ?? 0), (e) => { console.error(e); process.exit(1); });
