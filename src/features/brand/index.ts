// Brand 模块 Public API
// 双 seam 设计（M14）：本文件供页面/服务消费，HTTP handlers 从 "./brand.api" 直连
export * as brandQueries from "./brand.queries";
export * as brandService from "./brand.service";
export { BrandCenterPage } from "./brand.routes";
export type { BrandOverview, BrandIdentity } from "./brand.queries";
export type { SubmitProductInput } from "./brand.service";
