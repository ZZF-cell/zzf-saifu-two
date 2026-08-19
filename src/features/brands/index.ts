// 商家管理模块 Public API（/brands）
// 双 seam 设计（M14）：本文件供页面消费，HTTP handlers 复用 /api/admin/brands*（ADMIN_ROLES 守卫）
// 职责：最高权限者/管理员的「商家管理」入口——查看所有入驻品牌（全部状态），并可执行审核/删除
export { BrandManagementPage } from "./brands.routes";
