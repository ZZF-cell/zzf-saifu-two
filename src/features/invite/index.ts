// Invite 模块 Public API — 品牌入驻激活
// 双 seam 设计（M14）：本文件供页面/服务消费，HTTP handlers 从 "./invite.api" 直连
export * as inviteService from "./invite.service";
export { InvitePage } from "./invite.routes";
export type { ActivateInviteInput, ActivateInviteResult } from "./invite.service";
