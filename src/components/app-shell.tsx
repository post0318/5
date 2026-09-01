"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, LineChart, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { MARKETS, isMarketId } from "@/lib/markets/types";
import { ThemeToggle } from "@/components/theme-toggle";

const SUBNAV = [
  { seg: "analysis", label: "종목분석", icon: BarChart3 },
  { seg: "universe", label: "유니버스 통합 뷰", icon: LineChart },
] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const parts = pathname.split("/").filter(Boolean);
  const market = parts[0] && isMarketId(parts[0]) ? parts[0] : "kr";
  const sub = parts[1] === "universe" ? "universe" : "analysis";
  const onManage = parts[0] === "manage";

  return (
    <div className="flex min-h-full flex-col">
      <header className="bg-background/80 sticky top-0 z-30 border-b backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-6 px-4">
          <Link href="/kr/analysis" className="flex items-center gap-2 font-semibold">
            <span className="bg-primary text-primary-foreground grid size-6 place-items-center rounded text-xs">
              G
            </span>
            <span className="hidden sm:inline">글로벌 종목 리서치</span>
          </Link>

          {/* 시장 탭 */}
          <nav className="flex items-center gap-1">
            {MARKETS.map((m) => {
              const active = !onManage && m.id === market;
              return (
                <Link
                  key={m.id}
                  href={`/${m.id}/${sub}`}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    active
                      ? "bg-secondary text-secondary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {m.label}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-1">
            <Link
              href="/manage"
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                onManage
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Settings2 className="size-4" />
              <span className="hidden sm:inline">유니버스 관리</span>
            </Link>
            <ThemeToggle />
          </div>
        </div>

        {/* 서브 내비 */}
        {!onManage && (
          <div className="mx-auto max-w-[1400px] px-4">
            <div className="flex gap-4">
              {SUBNAV.map((s) => {
                const active = s.seg === sub;
                return (
                  <Link
                    key={s.seg}
                    href={`/${market}/${s.seg}`}
                    className={cn(
                      "flex items-center gap-1.5 border-b-2 py-2.5 text-sm transition-colors",
                      active
                        ? "border-primary text-foreground"
                        : "text-muted-foreground hover:text-foreground border-transparent",
                    )}
                  >
                    <s.icon className="size-3.5" />
                    {s.label}
                  </Link>
                );
              })}
            </div>
          </div>
        )}
      </header>

      <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6">{children}</main>

      <footer className="text-muted-foreground border-t px-4 py-4 text-center text-xs">
        개인용 리서치 도구 · 시세 EOD · 포워드 컨센서스는 yahoo-finance2(개인용) ·
        확장 시 데이터 소스 재검토 필요 (prd.md §4.3)
      </footer>
    </div>
  );
}
