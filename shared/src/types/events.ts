export const DOMAIN_EVENTS = {
  DEAL_STAGE_CHANGED: "deal.stage.changed",
  DEAL_WON: "deal.won",
  DEAL_LOST: "deal.lost",
  CONTACT_CREATED: "contact.created",
  EMAIL_RECEIVED: "email.received",
  EMAIL_SENT: "email.sent",
  FILE_UPLOADED: "file.uploaded",
  ACTIVITY_CREATED: "activity.created",
  TASK_COMPLETED: "task.completed",
  TASK_ASSIGNED: "task.assigned",
  SCOPING_INTAKE_READY: "scoping_intake.ready",
  SCOPING_INTAKE_ACTIVATED: "scoping_intake.activated",
  SCOPING_INTAKE_REOPENED: "scoping_intake.reopened",
  SCOPING_INTAKE_ATTACHMENT_ADDED: "scoping_intake.attachment.added",
  NOTIFICATION_CREATED: "notification.created",
  APPROVAL_REQUESTED: "approval.requested",
  APPROVAL_RESOLVED: "approval.resolved",
  AI_SUGGEST_ACTION: "ai.suggest_action",
} as const;

export type DomainEventName = (typeof DOMAIN_EVENTS)[keyof typeof DOMAIN_EVENTS];

export interface DomainEvent<T = unknown> {
  name: DomainEventName;
  payload: T;
  officeId: string;
  userId: string;
  timestamp: Date;
}
