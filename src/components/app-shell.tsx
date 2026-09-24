"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  Building2,
  CalendarDays,
  Flag,
  Globe,
  Landmark,
  Lightbulb,
  LineChart,
  MountainSnow,
  Newspaper,
  Settings2,
  TrendingUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { MARKETS, isMarketId, type MarketId } from "@/lib/markets/types";
import { ThemeToggle } from "@/components/theme-toggle";
import { AccountMenu } from "@/components/auth/account-menu";

// 시장 탭 아이콘(오너 지시 2026-09-24) — 국기 이모지는 윈도우에서 텍스트
// (KR/US/JP)로 깨져 보이고, 손으로 그린 지도 실루엣·색깔 이모지(호랑이/
// 독수리/후지산)는 둘 다 "조잡해 보인다/통일성이 떨어진다"는 반응이었다
// (스크린샷 확인, 2026-09-24) — 컬러 이모지가 나머지 내비(Globe/Newspaper 등
// lucide 단색 라인 아이콘)와 스타일이 섞여 어색했던 것. OS 폰트에 기대는
// 이모지 대신 나머지 내비와 같은 lucide SVG 아이콘으로 통일(렌더링도
// 플랫폼 무관하게 항상 동일).
const MARKET_ICONS: Record<MarketId, typeof Landmark> = {
  kr: Landmark, // 고궁 등 랜드마크
  us: Flag,
  jp: MountainSnow, // 후지산
};

const SUBNAV = [
  { seg: "universe", label: "유니버스 통합 뷰", icon: LineChart },
  { seg: "news", label: "유니버스통합 뉴스", icon: Newspaper },
  { seg: "analysis", label: "종목분석", icon: BarChart3 },
  { seg: "research", label: "산업분석", icon: Building2 },
  { seg: "insights", label: "인사이트", icon: Lightbulb },
] as const;

// 거시경제 서브 내비(오너 지시 2026-09-24 — "거시경제 클릭시 상단 탭으로
// 글로벌핵심지표 이슈분석을 구성"). seg가 빈 문자열이면 `/macro` 자체.
const MACRO_SUBNAV = [
  { seg: "", label: "글로벌핵심지표", icon: Globe },
  { seg: "issues", label: "이슈분석", icon: Newspaper },
  { seg: "fx", label: "환율분석", icon: TrendingUp },
] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const parts = pathname.split("/").filter(Boolean);
  const market = parts[0] && isMarketId(parts[0]) ? parts[0] : "kr";
  const sub =
    parts[1] === "analysis"
      ? "analysis"
      : parts[1] === "news"
        ? "news"
        : parts[1] === "research"
          ? "research"
          : parts[1] === "insights"
            ? "insights"
            : "universe";
  const onManage = parts[0] === "manage";
  const onMacro = parts[0] === "macro";
  const onWeekly = parts[0] === "weekly";
  const onAdmin = parts[0] === "admin";

  return (
    <div className="flex min-h-full flex-col">
      <header className="bg-background/80 sticky top-0 z-30 border-b backdrop-blur">
        <div className="mx-auto flex min-h-14 max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-1 px-4 py-2">
          <Link href="/kr/universe" className="flex items-center gap-2 font-semibold">
            <span className="bg-primary text-primary-foreground grid size-6 place-items-center rounded text-xs">
              G
            </span>
            <span className="hidden sm:inline">글로벌 종목 리서치</span>
          </Link>

          {/* 시장 탭 */}
          <nav className="flex items-center gap-1">
            {MARKETS.map((m) => {
              const active = !onManage && !onMacro && !onWeekly && m.id === market;
              const Icon = MARKET_ICONS[m.id];
              return (
                <Link
                  key={m.id}
                  href={`/${m.id}/${sub}`}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    active
                      ? "bg-secondary text-secondary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon aria-hidden="true" className="size-3.5" />
                  {m.label}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-1">
            <Link
              href="/macro"
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                onMacro
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Globe className="size-4" />
              <span className="hidden sm:inline">거시경제</span>
            </Link>
            <Link
              href="/weekly"
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                onWeekly
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <CalendarDays className="size-4" />
              <span className="hidden sm:inline">주간 리포트</span>
            </Link>
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
            <AccountMenu />
            <ThemeToggle />
          </div>
        </div>

        {/* 서브 내비 */}
        {!onManage && !onMacro && !onWeekly && !onAdmin && (
          <div className="mx-auto max-w-[1400px] overflow-x-auto px-4">
            <div className="flex w-max min-w-full gap-4">
              {SUBNAV.map((s) => {
                const active = s.seg === sub;
                // 국내는 해외IB 인사이트가 없어 비상장 리서치로 대체한다(오너
                // 지시, 2026-09-24) — 탭 라벨도 시장에 따라 다르게 표시.
                const label = s.seg === "insights" && market === "kr" ? "비상장 리서치" : s.label;
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
                    {label}
                  </Link>
                );
              })}
            </div>
          </div>
        )}
        {onMacro && (
          <div className="mx-auto max-w-[1400px] overflow-x-auto px-4">
            <div className="flex w-max min-w-full gap-4">
              {MACRO_SUBNAV.map((s) => {
                const active = (parts[1] ?? "") === s.seg;
                return (
                  <Link
                    key={s.seg}
                    href={s.seg ? `/macro/${s.seg}` : "/macro"}
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
    </div>
  );
}
