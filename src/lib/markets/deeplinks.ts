/**
 * L4(포워드 컨센서스) · L5(뉴스) 딥링크 빌더 (prd.md §4.6)
 *
 * 인앱 데이터의 상세·검증용 병행 링크. 스크래핑 아님 — 사용자를 원본 사이트로 보낸다.
 * URL 패턴은 변경될 수 있으므로 한 곳에서 관리한다.
 */

import type { DeepLink, MarketId } from "./types";

const enc = encodeURIComponent;

/** 한국 종목코드(6자리) 정규화. "A005930" → "005930" */
function krCode(symbol: string): string {
  return symbol.replace(/[^0-9]/g, "").padStart(6, "0").slice(-6);
}

/** 일본 종목: "7203" 또는 "7203.T" → 코드/야후심볼 */
function jpParts(symbol: string): { code: string; yahoo: string } {
  const code = symbol.replace(/\.T$/i, "").trim();
  return { code, yahoo: `${code}.T` };
}

export function consensusDeepLinks(market: MarketId, symbol: string): DeepLink[] {
  switch (market) {
    case "kr": {
      const code = krCode(symbol);
      return [
        {
          label: "네이버페이 증권 — 종목분석",
          url: `https://finance.naver.com/item/coinfo.naver?code=${code}`,
        },
        {
          label: "컴퍼니가이드 — Snapshot",
          url: `https://comp.fnguide.com/SVO2/ASP/SVD_Main.asp?pGB=1&gicode=A${code}`,
        },
      ];
    }
    case "us": {
      const t = symbol.toUpperCase();
      return [
        { label: "StockAnalysis — Forecast", url: `https://stockanalysis.com/stocks/${enc(t.toLowerCase())}/forecast/` },
        { label: "Yahoo Finance — Analysis", url: `https://finance.yahoo.com/quote/${enc(t)}/analysis/` },
        { label: "MarketScreener", url: `https://www.marketscreener.com/search/?q=${enc(t)}` },
      ];
    }
    case "jp": {
      const { code, yahoo } = jpParts(symbol);
      return [
        { label: "Yahoo Finance — Analysis", url: `https://finance.yahoo.com/quote/${enc(yahoo)}/analysis/` },
        { label: "MarketScreener", url: `https://www.marketscreener.com/search/?q=${enc(code)}` },
        { label: "IR BANK", url: `https://irbank.net/${enc(code)}` },
      ];
    }
  }
}

export function newsDeepLinks(market: MarketId, symbol: string): DeepLink[] {
  switch (market) {
    case "kr": {
      const code = krCode(symbol);
      return [
        { label: "네이버페이 증권 — 뉴스", url: `https://finance.naver.com/item/news.naver?code=${code}` },
      ];
    }
    case "us": {
      const t = symbol.toUpperCase();
      return [
        { label: "Yahoo Finance — News", url: `https://finance.yahoo.com/quote/${enc(t)}/news/` },
        { label: "StockAnalysis", url: `https://stockanalysis.com/stocks/${enc(t.toLowerCase())}/` },
      ];
    }
    case "jp": {
      const { code, yahoo } = jpParts(symbol);
      return [
        { label: "Yahoo!ファイナンス", url: `https://finance.yahoo.co.jp/quote/${enc(`${code}.T`)}` },
        { label: "IR BANK", url: `https://irbank.net/${enc(code)}` },
        { label: "Yahoo Finance — News", url: `https://finance.yahoo.com/quote/${enc(yahoo)}/news/` },
      ];
    }
  }
}

export function filingsDeepLink(market: MarketId, symbol: string): DeepLink | null {
  switch (market) {
    case "kr": {
      const code = krCode(symbol);
      return {
        label: "DART — 전자공시",
        url: `https://dart.fss.or.kr/dsab007/main.do?option=corp&textCrpNm=${code}`,
      };
    }
    case "us": {
      const t = symbol.toUpperCase();
      return {
        label: "SEC EDGAR — Filings",
        url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&ticker=${enc(t)}&type=&dateb=&owner=include&count=40`,
      };
    }
    case "jp": {
      return {
        label: "EDINET — 書類検索",
        url: "https://disclosure2.edinet-fsa.go.jp/week0010.aspx",
      };
    }
  }
}
