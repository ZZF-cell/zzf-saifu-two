// 订单事件发布（仅订单模块内部使用，组合根在 orders.api 调用）
//
// 位置说明：放在 orders 模块内而非 shared/adapters ——
// 若放 shared 会导致共享基座反向依赖 Inngest 基础设施（shared→inngest→features→shared 分层倒置）。
//
// 投递可靠性：调用方需用 next/server 的 after() 包裹，
// 保证 serverless 中响应返回后投递仍完成；本函数内部对失败静默降级
// （Inngest 未配置/网络失败时不影响下单主流程，超时取消缺失由兜底流程承接）。

import { inngest } from "@/inngest/client";

export function notifyOrderCreated(orderId: string): Promise<void> {
  return inngest
    .send({ name: "order/created", data: { orderId } })
    .then(() => undefined)
    .catch(() => {
      // 静默降级：不阻塞下单核心流程
    });
}
