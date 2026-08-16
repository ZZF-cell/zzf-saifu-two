// Products 模块 Public API
// 双 seam 设计（M14）：本文件供页面/服务消费，HTTP handlers 从 "./products.api" 直连
export * as productsService from "./products.service";
export { HomePage, ProductDetailPage } from "./products.routes";
export { ProductCard, ProductGrid, CategoryFilter, SearchBar, SortSelector, Pagination } from "./products.components";
export type { ProductCardData } from "./products.components";
export type { ProductListItem, ProductDetail, ProductListParams, ProductListResult } from "./products.service";
