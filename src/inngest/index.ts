// Inngest 模块 — 客户端 + 函数注册中心
// 新增异步函数时：在 functions/ 下创建文件并在此导出

import { orderTimeoutCancel } from "./functions/order-timeout-cancel";
import { orderExpirySweep } from "./functions/order-expiry-sweep";

export { inngest } from "./client";
export { orderTimeoutCancel, orderExpirySweep };

/** 全部 Inngest 函数（serve 端点 + Dev Server 自动发现） */
export const inngestFunctions = [orderTimeoutCancel, orderExpirySweep];
