// Service 模块 DTO 类型 — client-safe（纯类型 + 常量，零依赖）
//
// 与 user.types.ts 同规则：禁止引入任何 server 依赖，
// client 组件可安全 `import type` / 常量（TICKET_CATEGORIES 供表单下拉）。

export const TICKET_CATEGORIES = ["PRESALE", "AFTERSALE", "OTHER"] as const;
export const TICKET_STATUSES = ["OPEN", "PROCESSING", "RESOLVED", "CLOSED"] as const;

export type TicketCategory = (typeof TICKET_CATEGORIES)[number];
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** 工单内一条消息（senderRole 为角色快照，注销后仍可辨发言方） */
export interface TicketMessage {
  id: string;
  senderRole: string; // USER | CUSTOMER_SERVICE | ADMIN | SUPER
  content: string;
  createdAt: Date;
}

export interface TicketSummary {
  id: string;
  title: string;
  category: TicketCategory;
  status: TicketStatus;
  orderId: string | null;
  productId: string | null;
  userName: string | null; // 提交人昵称（用户列表 = 自己昵称；客服列表 = 工单作者）
  lastMessage: TicketMessage | null;
  /** 客服视角：用户发来、客服尚未读的消息数；用户侧恒 0（isRead 只标记客服已读） */
  unreadCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface TicketDetail extends TicketSummary {
  messages: TicketMessage[]; // 完整对话线程（时间升序）
}

export interface TicketListResult {
  items: TicketSummary[];
  total: number;
  page: number;
  pageSize: number;
}
