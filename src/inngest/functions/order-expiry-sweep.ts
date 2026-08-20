// Inngest 函数 — 过期 PENDING 订单兜底清扫（cron）
// 触发: 每 5 分钟
// 作用: 事件驱动超时取消（order-timeout-cancel）之外的第二道兜底——
//       即使 order/created 事件投递失败/Inngest 未配置，此 cron 也会周期扫掉
//       超过支付时限仍未支付的 PENDING 订单并回补库存。
// 过期口径: 下单 createdAt + ORDER_PAYMENT_TIMEOUT_MS（无 expiresAt 列，派生自 createdAt）
// 安全: cancelExpiredOrder 自带 status=PENDING 状态守卫，已支付/已取消订单静默 no-op
// 注意: 本目录在 eslint.config.mjs 的 boundaries ignores 中（inngest/**），可直连 feature Public API

import { inngest } from "@/inngest/client";
import { prisma } from "@/shared/db/client";
import { cancelExpiredOrder, ORDER_PAYMENT_TIMEOUT_MS, ORDER_STATUS } from "@/features/orders";

/** 单次清扫批次上限：避免一次函数执行拉取过多历史订单 */
const SWEEP_BATCH = 50;

export const orderExpirySweep = inngest.createFunction(
  { id: "order-expiry-sweep" },
  { cron: "*/5 * * * *" },
  async ({ step, event }) => {
    void event; // cron 触发：event 为 ScheduledTimer 事件（仅用于帮助 TS 推断触发类型）
    return step.run("清扫过期未支付订单", async () => {
      const cutoff = new Date(Date.now() - ORDER_PAYMENT_TIMEOUT_MS);
      // 找出已过支付时限仍未支付的 PENDING 订单（只取 id，最小化数据量；createdAt 已建索引）
      const expired = await prisma.order.findMany({
        where: {
          status: ORDER_STATUS.PENDING,
          createdAt: { lt: cutoff },
        },
        select: { id: true },
        // 最老先处理：无 orderBy 时每次取任意 50 单，若过期单持续涌入，老单可能永远排在
        // 批次之外被饿死（一直滞留 PENDING 不回补库存）
        orderBy: { createdAt: "asc" },
        take: SWEEP_BATCH,
      });

      let cancelled = 0;
      for (const o of expired) {
        const result = await cancelExpiredOrder(o.id);
        if (result.cancelled) cancelled += 1;
      }
      return { scanned: expired.length, cancelled };
    });
  },
);
