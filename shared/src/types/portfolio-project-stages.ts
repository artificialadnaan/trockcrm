export const PORTFOLIO_PROJECT_BOARD_STAGES = [
  "bidding",
  "buyout",
  "close out",
  "close out - final invoice",
  "closed",
  "contract executed",
  "in production",
] as const;

export type PortfolioProjectBoardStage = typeof PORTFOLIO_PROJECT_BOARD_STAGES[number];

const STAGE_ALIASES: Record<string, PortfolioProjectBoardStage> = {
  "bid": "bidding",
  "bidding": "bidding",
  "buy out": "buyout",
  "buy-out": "buyout",
  "buyout": "buyout",
  "closeout": "close out",
  "close out": "close out",
  "close-out": "close out",
  "close out final invoice": "close out - final invoice",
  "close out - final invoice": "close out - final invoice",
  "close-out final invoice": "close out - final invoice",
  "closeout final invoice": "close out - final invoice",
  "closed": "closed",
  "contract executed": "contract executed",
  "contracts executed": "contract executed",
  "in production": "in production",
  "production": "in production",
};

export function normalizePortfolioProjectStage(stage: string | null | undefined): string {
  const normalized = String(stage ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, " ")
    .replace(/\s*-\s*/g, " - ")
    .replace(/\s+/g, " ");

  const hyphenAsSpace = normalized.replace(/\s*-\s*/g, " ").replace(/\s+/g, " ");
  const compactHyphen = normalized.replace(/\s*-\s*/g, "-");

  return STAGE_ALIASES[normalized]
    ?? STAGE_ALIASES[hyphenAsSpace]
    ?? STAGE_ALIASES[compactHyphen]
    ?? normalized;
}

export function isPortfolioProjectBoardStage(stage: string | null | undefined): stage is PortfolioProjectBoardStage {
  return PORTFOLIO_PROJECT_BOARD_STAGES.includes(
    normalizePortfolioProjectStage(stage) as PortfolioProjectBoardStage
  );
}
