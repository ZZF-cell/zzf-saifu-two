// 阿里云短信适配器
// 未配置 SMS_ACCESS_KEY_ID 时回退到终端日志输出（开发环境）

interface SmsResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export async function sendSms(
  phone: string,
  code: string,
): Promise<SmsResult> {
  // 未配置短信服务 → 回退到终端日志
  if (!process.env.SMS_ACCESS_KEY_ID || !process.env.SMS_ACCESS_KEY_SECRET) {
    console.log(`[SMS] ===== 验证码 =====`);
    console.log(`[SMS] 手机号: ${phone}`);
    console.log(`[SMS] 验证码: ${code}`);
    console.log(`[SMS] ==================`);
    return { success: true, messageId: "dev-fallback" };
  }

  try {
    // TODO: 集成阿里云短信 SDK
    // const Core = require("@alicloud/pop-core");
    // const client = new Core({ ... });
    // const result = await client.request("SendSms", { ... });
    // return { success: true, messageId: result.BizId };
    return { success: true, messageId: "placeholder" };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[SMS] 发送失败:", msg);
    return { success: false, error: msg };
  }
}
