// Products 模块 Public API
export * as productsService from "./products.service";
export { HomePage, ProductDetailPage } from "./products.routes";
export { ProductCard, ProductGrid, CategoryFilter, SearchBar, SortSelector, Pagination } from "./products.components";
export type { ProductCardData } from "./products.components";
export type { ProductListItem, ProductDetail, ProductListParams, ProductListResult } from "./products.service";
