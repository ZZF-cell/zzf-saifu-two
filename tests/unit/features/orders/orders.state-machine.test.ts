// 订单状态机单元测试 — 覆盖率目标 100%
import { describe, it, expect } from "vitest";
import {
  ORDER_STATUS,
  canTransitionTo,
  isCancellable,
  isRefundable,
  isPayable,
  isDestroyable,
  assertTransition,
  getAllowedTransitions,
} from "@/features/orders/orders.state-machine";

// ── canTransitionTo ──

describe("canTransitionTo — 状态转换合法性", () => {
  it("PENDING → PAID（允许）", () => {
    expect(canTransitionTo("PENDING", "PAID")).toBe(true);
  });

  it("PENDING → CANCELLED（允许）", () => {
    expect(canTransitionTo("PENDING", "CANCELLED")).toBe(true);
  });

  it("PENDING → SHIPPED（禁止 — 必须先支付）", () => {
    expect(canTransitionTo("PENDING", "SHIPPED")).toBe(false);
  });

  it("PENDING → REFUNDED（禁止）", () => {
    expect(canTransitionTo("PENDING", "REFUNDED")).toBe(false);
  });

  it("PAID → SHIPPED（允许）", () => {
    expect(canTransitionTo("PAID", "SHIPPED")).toBe(true);
  });

  it("PAID → CANCELLED（允许 — 已支付的订单仍可取消）", () => {
    expect(canTransitionTo("PAID", "CANCELLED")).toBe(true);
  });

  it("PAID → REFUND_REQUESTED（允许）", () => {
    expect(canTransitionTo("PAID", "REFUND_REQUESTED")).toBe(true);
  });

  it("PAID → REFUNDED（禁止 — 必须先申请退款）", () => {
    expect(canTransitionTo("PAID", "REFUNDED")).toBe(false);
  });

  it("SHIPPED → DELIVERED（允许）", () => {
    expect(canTransitionTo("SHIPPED", "DELIVERED")).toBe(true);
  });

  it("SHIPPED → CANCELLED（允许）", () => {
    expect(canTransitionTo("SHIPPED", "CANCELLED")).toBe(true);
  });

  it("DELIVERED → COMPLETED（允许）", () => {
    expect(canTransitionTo("DELIVERED", "COMPLETED")).toBe(true);
  });

  it("DELIVERED → CANCELLED（允许 — 送达后仍可取消/销毁）", () => {
    expect(canTransitionTo("DELIVERED", "CANCELLED")).toBe(true);
  });

  it("COMPLETED → CANCELLED（允许 — 完成后可销毁）", () => {
    expect(canTransitionTo("COMPLETED", "CANCELLED")).toBe(true);
  });

  it("REFUND_REQUESTED → REFUNDED（允许）", () => {
    expect(canTransitionTo("REFUND_REQUESTED", "REFUNDED")).toBe(true);
  });

  it("REFUND_REQUESTED → CANCELLED（允许）", () => {
    expect(canTransitionTo("REFUND_REQUESTED", "CANCELLED")).toBe(true);
  });

  it("REFUNDED → CANCELLED（允许 — 退款后可销毁）", () => {
    expect(canTransitionTo("REFUNDED", "CANCELLED")).toBe(true);
  });

  // 终态不可再转换
  it("CANCELLED → any（禁止 — 终态）", () => {
    expect(canTransitionTo("CANCELLED", "PAID")).toBe(false);
    expect(canTransitionTo("CANCELLED", "PENDING")).toBe(false);
    expect(canTransitionTo("CANCELLED", "COMPLETED")).toBe(false);
  });

  it("unknown status — 永远false", () => {
    expect(canTransitionTo("UNKNOWN" as never, "PAID" as never)).toBe(false);
  });
});

// ── isCancellable ──

describe("isCancellable — 是否可取消", () => {
  it("PENDING / PAID / SHIPPED / DELIVERED / COMPLETED 可取消", () => {
    expect(isCancellable("PENDING")).toBe(true);
    expect(isCancellable("PAID")).toBe(true);
    expect(isCancellable("SHIPPED")).toBe(true);
    expect(isCancellable("DELIVERED")).toBe(true);
    expect(isCancellable("COMPLETED")).toBe(true);
    expect(isCancellable("REFUND_REQUESTED")).toBe(true);
    expect(isCancellable("REFUNDED")).toBe(true);
  });

  it("CANCELLED 不可取消（已取消）", () => {
    expect(isCancellable("CANCELLED")).toBe(false);
  });
});

// ── isRefundable ──

describe("isRefundable — 是否可申请退款", () => {
  it("PAID / SHIPPED / DELIVERED 可退款", () => {
    expect(isRefundable("PAID")).toBe(true);
    expect(isRefundable("SHIPPED")).toBe(true);
    expect(isRefundable("DELIVERED")).toBe(true);
  });

  it("PENDING / CANCELLED / COMPLETED / REFUNDED 不可退款", () => {
    expect(isRefundable("PENDING")).toBe(false);
    expect(isRefundable("CANCELLED")).toBe(false);
    expect(isRefundable("COMPLETED")).toBe(false);
    expect(isRefundable("REFUNDED")).toBe(false);
  });
});

// ── isPayable ──

describe("isPayable — 是否可被支付回调标记为PAID", () => {
  it("仅 PENDING 可支付", () => {
    expect(isPayable("PENDING")).toBe(true);
  });

  it("非 PENDING 不可支付（幂等/异常场景）", () => {
    expect(isPayable("PAID")).toBe(false);
    expect(isPayable("CANCELLED")).toBe(false);
    expect(isPayable("COMPLETED")).toBe(false);
  });
});

// ── isDestroyable ──

describe("isDestroyable — 是否可销毁", () => {
  it("CANCELLED / COMPLETED / REFUNDED 可销毁", () => {
    expect(isDestroyable("CANCELLED")).toBe(true);
    expect(isDestroyable("COMPLETED")).toBe(true);
    expect(isDestroyable("REFUNDED")).toBe(true);
  });

  it("PENDING / PAID 不可销毁", () => {
    expect(isDestroyable("PENDING")).toBe(false);
    expect(isDestroyable("PAID")).toBe(false);
  });
});

// ── assertTransition ──

describe("assertTransition", () => {
  it("合法转换不抛出", () => {
    expect(() => assertTransition("PENDING", "PAID", "order-1")).not.toThrow();
  });

  it("非法转换抛出 Error", () => {
    expect(() => assertTransition("CANCELLED", "PAID", "order-1")).toThrow(
      "订单 order-1 状态转换非法: CANCELLED → PAID",
    );
  });
});

// ── getAllowedTransitions ──

describe("getAllowedTransitions", () => {
  it("PENDING 可转为 PAID 和 CANCELLED", () => {
    const transitions = getAllowedTransitions("PENDING");
    expect(transitions).toContain("PAID");
    expect(transitions).toContain("CANCELLED");
    expect(transitions).not.toContain("SHIPPED");
  });

  it("CANCELLED 终态返回空数组", () => {
    expect(getAllowedTransitions("CANCELLED")).toEqual([]);
  });
});
