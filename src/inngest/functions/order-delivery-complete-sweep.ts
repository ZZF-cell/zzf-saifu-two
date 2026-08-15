// Inngest 函数 — 送达超时自动确认收货兜底清扫（cron）
// 触发: 每天凌晨 3 点
// 作用: 用户确认收货（confirmReceipt）/ 后台标记完成（admin completeOrder）之外的第二道兜底——
//       送达（deliveredAt）起 AUTO_CONFIRM_RECEIPT_MS（7 天）用户仍未手动确认收货时，
//       此 cron 自动将 DELIVERED 订单标记为 COMPLETED，让订单进入可销毁终态（隐私保护闭环）。
// 过期口径: deliveredAt + AUTO_CONFIRM_RECEIPT_MS（7 天窗口，与用户确认收货共用同一常量）
// 安全: autoCompleteDeliveredOrder 自带 status=DELIVERED 状态守卫，已确认/已销毁订单静默 no-op
// 注意: 本目录在 eslint.config.mjs 的 boundaries ignores 中（inngest/**），可直连 feature Public API

import { inngest } from "@/inngest/client";
import { prisma } from "@/shared/db/client";
import { autoCompleteDeliveredOrder, AUTO_CONFIRM_RECEIPT_MS, ORDER_STATUS } from "@/features/orders";

/** 单次清扫批次上限：避免一次函数执行拉取过多历史订单 */
const SWEEP_BATCH = 50;

export const orderDeliveryCompleteSweep = inngest.createFunction(
  { id: "order-delivery-complete-sweep" },
  { cron: "0 3 * * *" },
  async ({ step, event }) => {
    void event; // cron 触发：event 为 ScheduledTimer 事件（仅用于帮助 TS 推断触发类型）
    return step.run("清扫送达超时未确认收货订单", async () => {
      const cutoff = new Date(Date.now() - AUTO_CONFIRM_RECEIPT_MS);
      // 找出送达超过自动确认窗口仍未确认收货的 DELIVERED 订单（只取 id，最小化数据量）
      const overdue = await prisma.order.findMany({
        where: {
          status: ORDER_STATUS.DELIVERED,
          deliveredAt: { lt: cutoff },
        },
        select: { id: true },
        take: SWEEP_BATCH,
      });

      let completed = 0;
      for (const o of overdue) {
        const result = await autoCompleteDeliveredOrder(o.id);
        if (result.completed) completed += 1;
      }
      return { scanned: overdue.length, completed };
    });
  },
);
