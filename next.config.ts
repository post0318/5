import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 서버 전용 패키지는 번들하지 않고 Node가 직접 require 하게 둔다.
  // mongodb(오너 지시 2026-09-19 — Vercel "Deployment Storage" 10GB 초과
  // 대응, src/lib/db/* 를 쓰는 라우트 18곳에 번들마다 중복 포함되던 것 방지)
  // + 실측으로 함께 확인된 bson.
  //
  // **sharp 는 여기 넣지 않는다** — 실측(2026-09-22, route.js.nft.json 직접
  // 비교): serverExternalPackages 에 추가해도 함수 번들 크기가 그대로였다
  // (241MB → 241MB, 변화 없음). 이유: 이 옵션은 webpack 이 소스를 JS 번들에
  // 인라인하지 않게만 할 뿐이고, Vercel 의 파일 추적(Node File Trace)은
  // `await import("sharp")` 가 런타임에 실제로 필요하다고 보고 네이티브
  // 바이너리(@img/sharp-*)를 그대로 함수에 동봉한다 — mongodb 와 달리 sharp
  // 는 그 자체가 이미 최소 크기라 줄일 여지가 없다. lib/ppt/slide-data.ts
  // 의 TradingView 로고 SVG→PNG 변환(PPT 파워포인트 2007 호환용)이 유일한
  // 사용처이고, 그 기능을 없애지 않는 한 sharp 는 /api/ppt/* 두 함수에
  // 계속 포함된다.
  serverExternalPackages: ["yahoo-finance2", "@libsql/client", "libsql", "pptxgenjs", "mongodb", "bson"],
};

export default nextConfig;
