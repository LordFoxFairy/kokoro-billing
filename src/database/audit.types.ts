export type AuditAppendInput = Readonly<{
  tenantId: string;
  action: string;
  subjectId?: string;
  resourceType: string;
  resourceId?: string;
  reason: string;
  payload: Readonly<Record<string, unknown>>;
}>;
