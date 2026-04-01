export const DOMAIN_EVENTS = {
  DEAL_STAGE_CHANGED: "deal.stage.changed",
  DEAL_WON: "deal.won",
  DEAL_LOST: "deal.lost",
  CONTACT_CREATED: "contact.created",
  EMAIL_RECEIVED: "email.received",
  EMAIL_SENT: "email.sent",
  FILE_UPLOADED: "file.uploaded",
  TASK_COMPLETED: "task.completed",
  APPROVAL_REQUESTED: "approval.requested",
  APPROVAL_RESOLVED: "approval.resolved",
} as const;

export type DomainEventName = (typeof DOMAIN_EVENTS)[keyof typeof DOMAIN_EVENTS];

export interface DomainEvent<T = unknown> {
  name: DomainEventName;
  payload: T;
  officeId: string;
  userId: string;
  timestamp: Date;
}
