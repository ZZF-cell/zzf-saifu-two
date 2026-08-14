import {
  getAuditTemplates,
  upsertAuditTemplate,
  deleteAuditTemplate,
} from "@/features/admin/admin.api";
export const GET = getAuditTemplates;
export const PUT = upsertAuditTemplate;
export const DELETE = deleteAuditTemplate;
