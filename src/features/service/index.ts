// Service 模块 Public API
// 双 seam 设计（M14）：本文件供页面/服务消费，HTTP handlers 从 "./service.api" 直连
export * as serviceQueries from "./service.queries";
export * as serviceService from "./service.service";
export type {
  TicketCategory,
  TicketStatus,
  TicketMessage,
  TicketSummary,
  TicketDetail,
  TicketListResult,
} from "./service.types";
export { TICKET_CATEGORIES, TICKET_STATUSES } from "./service.types";
export { TicketsPage, TicketDetailPage } from "./service.routes";
