import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 서버 전용 패키지는 번들하지 않고 Node가 직접 require 하게 둔다.
  serverExternalPackages: ["yahoo-finance2", "@libsql/client", "libsql"],
};

export default nextConfig;
