// Orders 模块 Public API
// 双 seam 设计（M14）：本文件供页面/组件/查询消费（client 安全），
// HTTP route handlers 从 "./orders.api" 直连（server-only）——
// orders.api → payment → alipay-sdk 依赖 Node fs，若经 index 重导出会被拉进页面图
export * as ordersService from "./orders.service";
export * as ordersQueries from "./orders.queries";
export { CheckoutPage, OrderListPage, OrderDetailPage } from "./orders.routes";
export { OrderCard, OrderStatusBadge, OrderTimeline, AddressForm } from "./orders.components";
// H：DTO 类型收拢到 orders.types（client-safe），server 侧从 index 导入，client 侧直接 import types
export type {
  OrderSummary,
  OrderDetail,
  OrderListResult,
  BrandOrderRow,
  BrandOrderListResult,
  CreateOrderInput,
  CreateOrderResult,
} from "./orders.types";
export { getOrderListByBrand } from "./orders.queries";
export { cancelExpiredOrder, restoreStock, ORDER_PAYMENT_TIMEOUT_MS } from "./orders.service";
export {
  confirmReceipt,
  autoCompleteDeliveredOrder,
  AUTO_CONFIRM_RECEIPT_MS,
} from "./orders.service";
export {
  ORDER_STATUS,
  ORDER_STATUS_GROUPS,
  isCancellable,
  isRefundable,
  isPayable,
  isConfirmable,
  isDestroyable,
} from "./orders.state-machine";
export type { OrderStatus } from "./orders.state-machine";
