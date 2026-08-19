// User 模块 Public API
// 其他模块只能通过此文件访问 user 模块
// 双 seam 设计（M14）：本文件供页面/服务消费，HTTP handlers 从 "./user.api" 直连
export * as userQueries from "./user.queries";
export * as userService from "./user.service";
export type { UserProfile, OrderStats } from "./user.types";
export { AccountPage } from "./user.routes";
export { ChangePhoneForm, ChangePasswordForm, DeactivateSection } from "./user.account-forms";
