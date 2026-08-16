// Admin 模块 Public API
// 双 seam 设计（M14）：本文件供页面/查询消费（client 安全），
// HTTP route handlers 从 "./admin.api" 直连（server-only，避免 server 依赖进页面图）
export * as adminQueries from "./admin.queries";
export * as adminService from "./admin.service";
export { AdminDashboardPage } from "./admin.routes";
export type { DashboardStats } from "./admin.queries";
