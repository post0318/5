import "server-only";
import { geminiGenerate, isGeminiConfigured } from "../weekly/gemini";

/**
 * PPT 종목 원페이지의 "핵심 비즈니스 요약" 불릿 + "사업 생태계" 방사형
 * 다이어그램 데이터를 종목명만으로 자동 생성 — Gemini(웹검색 그라운딩) 버전.
 *
 * 오너 지시(2026-09) — 처음엔 이 기능을 Claude Haiku(학습 지식만, 실시간
 * 검색 없음)로 구현했으나 "차라리 제미나이를 연결할 수 있는 방안으로
 * 구축하는게 좋을듯해"라고 정정 — Gemini에 회사명만 주고 실시간 검색으로
 * 사업 구조를 정확히 뽑아낸 사례(한화에어로스페이스: K9 썬더·천무·누리호
 * 등 실제 제품명)를 근거로 제시했기 때문. 이 프로젝트엔 이미 주간 리포트
 * 기능(src/lib/weekly/gemini.ts)이 grounding(google_search 툴) 지원
 * Gemini REST 클라이언트를 구축해뒀어 그대로 재사용한다(새로 만들지 않음
 * — GEMINI_API_KEY 도 이미 .env.local/Vercel에 등록돼 있음).
 *
 * 재무 숫자(매출·EPS·PER 등)는 이 함수에 절대 담지 않는다 — DART/EDGAR/
 * Yahoo 실측 데이터 전용(slide-data.ts 다른 부분). 검색 그라운딩이 있어도
 * LLM이 숫자를 살짝 다르게 말할 위험이 있어, 재무제표 신뢰도를 지키려면
 * 섞지 않는 편이 안전.
 */
export interface GeminiBusinessProfile {
  bullets: string[];
  ecosystemCore: string;
  ecosystem: { label: string; category: string }[];
  costUsd: number;
}

const EMPTY: GeminiBusinessProfile = { bullets: [], ecosystemCore: "", ecosystem: [], costUsd: 0 };

export async function generateBusinessProfileGemini(
  name: string,
  sector: string | null,
): Promise<GeminiBusinessProfile> {
  if (!isGeminiConfigured()) return EMPTY;
  const system = `당신은 증권사 리서치 애널리스트입니다. 웹 검색으로 회사의 실제 사업
구조를 확인한 뒤, 오직 JSON 객체 하나만 출력하세요(다른 텍스트·설명·마크다운 코드블록 없이,
순수 JSON만):
{
  "bullets": ["핵심 투자 포인트 한국어 문장 1", "문장 2", "문장 3"],
  "ecosystemCore": "이 회사 사업의 본질을 나타내는 1~2단어(영문 가능, 예: Defense, Food, Semiconductor)",
  "ecosystem": [
    {"category": "사업 대분류(2~5글자)", "label": "구체적 제품·서비스·자회사명(2~8글자)"}
  ]
}
규칙:
- bullets 는 3개, 각 40자 내외 — 시장 지위·경쟁 우위·최근 방향성 위주로.
- ecosystem 은 6~10개 노드. 실제 제품명·사업부명·자회사명을 검색으로
  확인해 최대한 구체적으로 쓰세요("기타 사업" 같은 모호한 라벨 금지).
- 숫자(매출액·점유율%·주가 등)는 이 응답에 절대 포함하지 마세요 — 재무
  데이터는 별도 공식 API로 처리합니다.
- JSON 앞뒤에 다른 텍스트를 붙이지 마세요.`;
  const user = sector ? `회사명: ${name}\n업종: ${sector}` : `회사명: ${name}`;

  try {
    // maxOutputTokens 는 "사고(thinking)" 토큰까지 포함한 상한이라(실측 —
    // 2,000으로는 사고 토큰만으로 다 차 JSON이 중간에 잘려 파싱 실패)
    // 8,000으로 넉넉히 잡는다.
    const res = await geminiGenerate({ system, user, grounding: true, maxOutputTokens: 8000, temperature: 0.2 });
    const match = res.text.match(/\{[\s\S]*\}/);
    if (!match) return { ...EMPTY, costUsd: res.usage.costUsd };
    const parsed = JSON.parse(match[0]) as {
      bullets?: unknown;
      ecosystemCore?: unknown;
      ecosystem?: unknown;
    };
    const bullets = Array.isArray(parsed.bullets)
      ? parsed.bullets.filter((b): b is string => typeof b === "string" && b.trim().length > 0)
      : [];
    const ecosystem = Array.isArray(parsed.ecosystem)
      ? parsed.ecosystem
          .filter((n): n is { label: unknown; category: unknown } => typeof n === "object" && n !== null)
          .map((n) => ({
            label: String((n as { label?: unknown }).label ?? "").trim(),
            category: String((n as { category?: unknown }).category ?? "").trim(),
          }))
          .filter((n) => n.label.length > 0)
      : [];
    return {
      bullets,
      ecosystemCore: typeof parsed.ecosystemCore === "string" ? parsed.ecosystemCore.trim() : "",
      ecosystem,
      costUsd: res.usage.costUsd,
    };
  } catch (err) {
    console.error("[ppt] Gemini 사업 프로필 자동 생성 실패:", err);
    return EMPTY;
  }
}
