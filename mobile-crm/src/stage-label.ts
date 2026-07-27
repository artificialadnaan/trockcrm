import type { PipelineStage } from "./api/types";

/**
 * Turn a stage slug into something a rep can read, when no configured stage names the slug.
 *
 * Last resort only. "sent_to_production" becomes "Sent to production" — not the real display name, but
 * honest about which stage the deal is in, which is the whole job of this label.
 */
export function humanizeStageSlug(slug: string): string {
  const spaced = slug.replace(/_/g, " ").trim();
  if (!spaced) return slug;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The stage label for a deal.
 *
 * The ORDER matters, and getting it wrong is how a closed deal gets labelled "Opportunity":
 *
 *   1. `displayStageSlug` is the authoritative stage — bid-board-aware, so an owned deal that advanced
 *      or closed in Bid Board reports its real stage while its CRM stageId still points at an earlier
 *      one. When it is present it WINS, and if no configured stage names it (Bid Board-only slugs such
 *      as `sent_to_production` have no CRM pipeline row) the slug is humanized.
 *
 *      Falling back to the CRM stageId here would be actively wrong: that is a DIFFERENT, older stage,
 *      so the card would confidently display a stage the deal has already left. A slightly unpolished
 *      "Sent to production" beats a polished "Opportunity" that is false.
 *
 *   2. Only with no display slug at all does the CRM stageId name apply.
 *
 * Also degrades sanely when /deals/stages fails while the deals request succeeds: every card keeps a
 * label from its own slug instead of the whole column going blank.
 */
export function stageLabelFor(
  deal: { displayStageSlug?: string | null; stageSlug?: string | null; stageId?: string | null },
  stages: readonly PipelineStage[] | undefined,
): string | undefined {
  const bySlug = new Map<string, string>();
  const byId = new Map<string, string>();
  for (const stage of stages ?? []) {
    bySlug.set(stage.slug, stage.name);
    byId.set(stage.id, stage.name);
  }

  const displaySlug = deal.displayStageSlug ?? deal.stageSlug ?? null;
  if (displaySlug) return bySlug.get(displaySlug) ?? humanizeStageSlug(displaySlug);
  return deal.stageId ? byId.get(deal.stageId) : undefined;
}
