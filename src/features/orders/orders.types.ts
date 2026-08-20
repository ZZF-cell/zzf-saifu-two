// Orders 模块 DTO 类型 — client-safe（纯类型，零依赖）
//
// M14 seam 加固（H）：把 queries/service 中供消费端使用的 DTO 类型收拢到独立 types 文件，
// 与实现（prisma 查询、支付宝支付）物理隔离 —— client 组件可安全 `import type` 而不必
// 触碰 orders.queries / orders.service（后者 import prisma/alipay-sdk 会被编进 client 包）。
// 本文件禁止引入任何 server 依赖（prisma、alipay-sdk、node fs）。

// ── 订单列表/详情 ──

export interface OrderListResult {
  orders: OrderSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface OrderSummary {
  id: string;
  total: number;
  status: string;
  itemCount: number;
  firstItemName: string;
  createdAt: Date;
  /** 支付截止时间（ISO，= createdAt + ORDER_PAYMENT_TIMEOUT_MS）— 前端倒计时唯一真相源 */
  expiresAt: string;
  paidAt: Date | null;
}

export interface OrderDetail {
  id: string;
  total: number;
  status: string;
  shippingAddress: string;
  privacy: unknown;
  outTradeNo: string | null;
  paidAt: Date | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  refundedAt: Date | null;
  createdAt: Date;
  /** 支付截止时间（ISO，= createdAt + ORDER_PAYMENT_TIMEOUT_MS）— 前端倒计时唯一真相源 */
  expiresAt: string;
  items: {
    id: string;
    productName: string;
    price: number;
    qty: number;
    productId: string | null;
  }[];
}

// ── 品牌方订单列表 ──

export interface BrandOrderRow {
  id: string;
  status: string;
  createdAt: Date;
  paidAt: Date | null;
  brandSubtotal: number; // 本品牌商品行小计（分）= 各行 price 之和（price 已含 qty）
  firstItemName: string; // 本品牌首个商品名
}

export interface BrandOrderListResult {
  orders: BrandOrderRow[];
  total: number;
  page: number;
  pageSize: number;
}

// ── 下单输入/输出 ──

export interface CreateOrderItem {
  productId: string;
  qty: number;
}

export interface CreateOrderInput {
  items: CreateOrderItem[];
  shippingAddress: {
    name: string;
    phone: string;
    province: string;
    city: string;
    district: string;
    detail: string;
    zipCode?: string;
  };
  privacy: {
    anonymousPackaging: boolean;
    hideProductName: boolean;
  };
}

export interface CreateOrderResult {
  orderId: string;
  total: number;
  currency: string;
  status: string;
  /** 当面付二维码内容（支付宝 App 扫码支付）；未配置/失败时 null（订单已创建，可稍后到详情页续付） */
  qrCode: string | null;
  /**
   * 支付单创建状态（E1：支付失败对前端可见）：
   * - ok          二维码已生成，可直接拉起扫码
   * - unavailable 支付宝未配置（开发环境降级，前端提示「稍后继续支付」）
   * - failed      已配置但创建失败（真实异常，前端应给「去详情重试」入口）
   */
  paymentState: "ok" | "unavailable" | "failed";
  expiresAt: string;
}
