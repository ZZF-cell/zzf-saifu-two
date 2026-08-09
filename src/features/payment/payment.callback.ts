// 支付回调 — 支付宝异步回调签名校验
// 回调请求体为 application/x-www-form-urlencoded 表单，验签对象为完整表单字段（含 sign / sign_type）
// app_id 二次核验在 adapter 内完成（config 域归属 adapter，feature 层不直读 process.env）

import { paymentAdapter } from "@/shared/adapters/payment.adapter";
import { AppError, ERROR_CODES } from "@/shared/errors/errors";

/**
 * 校验支付宝异步回调签名
 *
 * @param body 完整回调表单字段（含 sign / sign_type）
 * @throws PAYMENT_SIGNATURE_INVALID 签名缺失或验证失败
 */
export async function verifyNotifySignature(
  body: Record<string, string>,
): Promise<void> {
  if (!body.sign) {
    throw new AppError(ERROR_CODES.PAYMENT_SIGNATURE_INVALID, "回调缺少签名");
  }

  const valid = await paymentAdapter.verifyCallback(body);
  if (!valid) {
    throw new AppError(ERROR_CODES.PAYMENT_SIGNATURE_INVALID, "回调签名验证失败");
  }
}
