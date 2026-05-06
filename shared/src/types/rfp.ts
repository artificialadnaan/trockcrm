export interface RfpRequestDeliveryPayload {
  dealId: string;
  syncHubUrl: string;
  body: Record<string, unknown>;
  dealHandled?: boolean | "claimed";
}
