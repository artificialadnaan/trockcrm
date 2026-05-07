export type LinkedRecordType = "deal" | "lead" | "contact" | "company" | "property";

export type LinkedRecord = {
  id: string;
  type: LinkedRecordType;
  label: string;
  href?: string;
};

export type EmailRow = {
  id: string;
  fromName: string;
  fromEmail: string;
  fromInitials: string;
  fromMe: boolean;
  subject: string;
  preview: string;
  date: string;
  status: "linked" | "unassigned" | "sent" | "low_confidence";
  linkedRecords?: LinkedRecord[];
  unread?: boolean;
  hasAttachment?: boolean;
  attachmentCount?: number;
};

export type RecordingRow = {
  id: string;
  contactName: string;
  contactInitials: string;
  direction: "inbound" | "outbound";
  durationSeconds: number;
  date: string;
  transcript?: string;
  hasTranscript: boolean;
  topics?: string[];
};
