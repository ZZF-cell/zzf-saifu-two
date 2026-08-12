// Inngest 函数 — 订单支付超时自动取消
// 触发: order/created 事件（下单时由 shared/adapters/order-events 投递）
// 流程: 等待 ORDER_PAYMENT_TIMEOUT_MS(30min) → 检查订单 → PENDING 则取消并回补库存
// 注意: 本目录在 eslint.config.mjs 的 boundaries ignores 中（inngest/**），可直连 feature Public API

import { inngest } from "@/inngest/client";
import {
  cancelExpiredOrder,
  ORDER_PAYMENT_TIMEOUT_MS,
} from "@/features/orders";

interface OrderCreatedEvent {
  data: { orderId: string };
}

export const orderTimeoutCancel = inngest.createFunction(
  { id: "order-timeout-cancel" },
  { event: "order/created" },
  async ({ event, step }) => {
    const { orderId } = (event as OrderCreatedEvent).data;

    await step.sleep("等待支付超时", ORDER_PAYMENT_TIMEOUT_MS);

    return step.run("检查并取消超时订单", async () => {
      // cancelExpiredOrder 内部自带状态守卫：
      // - 已支付(PAID) → no-op（订单已支付，无需取消）
      // - 已取消 → no-op
      // - PENDING → 回补库存并置 CANCELLED
      return cancelExpiredOrder(orderId);
    });
  },
);
