// 质检中心模块 Public API（/inspect）
// 双 seam 设计（M14）：本文件供页面消费，HTTP handlers 从 "./inspect.api" 直连
// 职责：商品审核（PENDING→通过/驳回 + 下架/重新上架）+ 质检模板管理
// 商品质检/质检模板 API 复用 /api/admin/products* 与 /api/admin/audit-templates*
// （守卫已改为 INSPECT_ROLES，与客服工作台复用 /api/admin/orders 同一模式）
export { InspectCenterPage } from "./inspect.routes";
