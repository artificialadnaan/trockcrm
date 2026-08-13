/**
 * The ONE place the Procore Bid Board deep link is built.
 *
 * It appears on the deal detail page (header link + the standing "disconnected from Bid Board" banner),
 * in the "Move back to Opportunity" confirm dialog — where it is the operator's route to the manual step
 * the CRM cannot perform for them — and on every row of SyncHub's daily estimates email.
 *
 * It lives in `shared` rather than in the client because the SERVER needs it too: the estimates feed hands
 * SyncHub a finished URL. When it was client-only, adding the feed meant writing the formula a second time,
 * and a subdomain or path change would then be applied to one copy and missed on the other — silently
 * breaking exactly the link this file exists to keep working.
 */
export function buildProcoreBidBoardProjectUrl(
  procoreCompanyId: string | null | undefined,
  procoreBidId: string | number | null | undefined
): string | null {
  if (!procoreCompanyId || procoreBidId == null || procoreBidId === "") return null;
  return `https://us02.procore.com/webclients/host/companies/${procoreCompanyId}/tools/bid-board/project/${procoreBidId}/details`;
}
