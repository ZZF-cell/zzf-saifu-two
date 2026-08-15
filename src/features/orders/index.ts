// Orders 模块 Public API
export * as ordersService from "./orders.service";
export * as ordersQueries from "./orders.queries";
export { CheckoutPage, OrderListPage, OrderDetailPage } from "./orders.routes";
export { OrderCard, OrderStatusBadge, OrderTimeline, AddressForm } from "./orders.components";
export type { OrderSummary, OrderDetail, OrderListResult } from "./orders.queries";
export { getOrderListByBrand } from "./orders.queries";
export type { BrandOrderRow, BrandOrderListResult } from "./orders.queries";
export type { CreateOrderInput, CreateOrderResult } from "./orders.service";
export { cancelExpiredOrder, restoreStock, ORDER_PAYMENT_TIMEOUT_MS } from "./orders.service";
export { ORDER_STATUS, isCancellable, isRefundable, isPayable, isDestroyable } from "./orders.state-machine";
export type { OrderStatus } from "./orders.state-machine";
