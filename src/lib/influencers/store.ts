import "server-only";
import { readFile } from "fs/promises";
import path from "path";

/**
 * 인플루언서(블로거/유튜버/텔레그램 채널) 목록. 1차 구현은 DB 대신 이
 * markdown 파일(`influencers.md`)을 사람이 직접 편집(오너 확인, 2026-09) —
 * 나중에 관리 화면이 필요해지면 이 모듈만 DB 조회로 바꾸면 되고, 호출부
 * (API 라우트)는 안 건드려도 된다.
 */

export interface Influencer {
  id: string;
  name: string;
  blogUrl?: string;
  youtubeUrl?: string;
  telegramUrl?: string;
}

const MD_PATH = path.join(process.cwd(), "src/lib/influencers/influencers.md");

function slugify(name: string, idx: number): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || `influencer-${idx}`;
}

function parseInfluencersMd(text: string): Influencer[] {
  // "## 이름" 으로 시작하는 블록만 읽는다. 첫 블록(파일 상단 설명)은 헤더가
  // 없으므로 split 결과의 첫 조각은 항상 버린다.
  const blocks = text.split(/^##[ \t]+/m).slice(1);
  return blocks.map((block, i) => {
    const lines = block.split("\n");
    const name = lines[0].trim();
    const inf: Influencer = { id: slugify(name, i), name };
    for (const line of lines.slice(1)) {
      const m = line.match(/^\s*(blog|youtube|telegram)\s*:\s*(\S+)/i);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const url = m[2];
      if (key === "blog") inf.blogUrl = url;
      else if (key === "youtube") inf.youtubeUrl = url;
      else if (key === "telegram") inf.telegramUrl = url;
    }
    return inf;
  });
}

export async function loadInfluencers(): Promise<Influencer[]> {
  let text: string;
  try {
    text = await readFile(MD_PATH, "utf-8");
  } catch {
    return [];
  }
  return parseInfluencersMd(text);
}

export async function getInfluencer(id: string): Promise<Influencer | null> {
  const list = await loadInfluencers();
  return list.find((i) => i.id === id) ?? null;
}
