import { jsonError, ok } from "@/lib/api";
import { getKrFearGreedFullHistory } from "@/lib/macro/kr/fear-greed";

// 프로젝트 6(코스피 백테스트)용 전체 히스토리 export. 대시보드 메인 라우트
// (/api/macro)와 분리해 캐시·페이로드에 영향 없음. 하루 내 재계산 불필요한
// 과거 데이터라 캐시를 길게 잡는다.
// 빌드 때 미리 만들지 않는다 — 빌드 시점엔 DB 가 없어 DB 항목이 빈 결과가 배포·재부팅 직후 첫 화면으로 나갔다(2026-10-04 실측). 외부 조회는 각 모듈 내부 캐시가 맡는다.
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  try {
    const data = await getKrFearGreedFullHistory();
    if (!data) return jsonError(new Error("K-FG 데이터 없음"));
    return ok(data);
  } catch (err) {
    return jsonError(err);
  }
}
