// 业务错误类 — 所有 Service 层只抛此类异常
// API 层通过 apiError 包装器统一捕获

export const ERROR_CODES = {
  // 认证 1xxx
  UNAUTHORIZED: { status: 401, code: "UNAUTHORIZED" },
  AGE_VERIFICATION_REQUIRED: { status: 403, code: "AGE_VERIFICATION_REQUIRED" },
  FORBIDDEN: { status: 403, code: "FORBIDDEN" },
  TOKEN_EXPIRED: { status: 401, code: "TOKEN_EXPIRED" },
  INVALID_CREDENTIALS: { status: 401, code: "INVALID_CREDENTIALS" },
  PHONE_ALREADY_EXISTS: { status: 409, code: "PHONE_ALREADY_EXISTS" },

  // 库存/商品 2xxx
  STOCK_CONFLICT: { status: 409, code: "STOCK_CONFLICT" },
  PRODUCT_NOT_FOUND: { status: 404, code: "PRODUCT_NOT_FOUND" },

  // 订单 3xxx
  ORDER_NOT_FOUND: { status: 404, code: "ORDER_NOT_FOUND" },
  ORDER_STATUS_INVALID: { status: 409, code: "ORDER_STATUS_INVALID" },
  ORDER_NOT_OWNED: { status: 403, code: "ORDER_NOT_OWNED" },
  CANCELLED_PAYMENT_ARRIVED: { status: 409, code: "CANCELLED_PAYMENT_ARRIVED" },

  // 支付 4xxx
  PAYMENT_FAILED: { status: 402, code: "PAYMENT_FAILED" },
  PAYMENT_SIGNATURE_INVALID: { status: 400, code: "PAYMENT_SIGNATURE_INVALID" },
  PAYMENT_NOT_CONFIGURED: { status: 503, code: "PAYMENT_NOT_CONFIGURED" },

  // 通用
  VALIDATION_ERROR: { status: 422, code: "VALIDATION_ERROR" },
  INTERNAL_ERROR: { status: 500, code: "INTERNAL_ERROR" },
} as const;

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(
    errorDef: { status: number; code: string },
    message: string,
  ) {
    super(message);
    this.name = "AppError";
    this.statusCode = errorDef.status;
    this.code = errorDef.code;
  }
}
