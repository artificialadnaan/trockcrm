/**
 * The ONE place the Procore Bid Board deep link is built.
 *
 * It appears on the deal detail page (header link + the standing "disconnected from Bid Board" banner)
 * and in the "Move back to Opportunity" confirm dialog, where it is the operator's route to the manual
 * step the CRM cannot perform for them — deleting the project from the Bid Board. Two independent
 * copies of the URL formula meant a subdomain or path change could be applied to one and missed on the
 * other, silently breaking exactly that link.
 */
export function buildProcoreBidBoardProjectUrl(
  procoreCompanyId: string | null | undefined,
  procoreBidId: string | number | null | undefined
): string | null {
  if (!procoreCompanyId || procoreBidId == null || procoreBidId === "") return null;
  return `https://us02.procore.com/webclients/host/companies/${procoreCompanyId}/tools/bid-board/project/${procoreBidId}/details`;
}
