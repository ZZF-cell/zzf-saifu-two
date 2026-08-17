// 阿里云短信适配器 — SendSms（RPC 风格，HMAC-SHA1 签名）
//
// 真实发送依赖环境变量（任一缺失 → 回退 dev-fallback，验证码仅终端日志，供本地/验收）：
//   SMS_ACCESS_KEY_ID / SMS_ACCESS_KEY_SECRET   阿里云 AccessKey（RAM 子账号，仅短信发送权限）
//   SMS_SIGN_NAME                               短信签名（需在阿里云审核通过）
//   SMS_TEMPLATE_CODE                           短信模板 Code（需含 ${code} 变量，审核通过）
//   SMS_TEMPLATE_PARAM                          （可选）模板变量名，默认 code
//
// 协议（阿里云官方公共参数 + 签名机制，V2017-05-25）：
//   GET https://dysmsapi.aliyuncs.com/?<公共参数 + 业务参数 + Signature>
//   签名 = base64( HMAC-SHA1( AccessKeySecret + "&", "GET&%2F&" + percentEncode(规范化查询串) ) )
//   规范化查询串 = 全部参数按键名字典序排列，每对 percentEncode(key)=percentEncode(value) 用 & 连接
//   成功判定：响应 Code === "OK"（BizId 为发送流水号）

import { createHmac, randomUUID } from "node:crypto";

const ENDPOINT = "https://dysmsapi.aliyuncs.com/";
const API_VERSION = "2017-05-25";

interface SmsResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/** RFC3986 百分号编码（阿里云 RPC 签名专用：空格→%20、*→%2A、~ 还原） */
export function percentEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/\+/g, "%20")
    .replace(/\*/g, "%2A")
    .replace(/%7E/g, "~");
}

/** 计算 RPC 签名：params 全量参数（含公共 + 业务）→ Signature 值 */
function buildSignature(params: Record<string, string>, accessKeySecret: string): string {
  const canonical = Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join("&");
  const stringToSign = `GET&${percentEncode("/")}&${percentEncode(canonical)}`;
  return createHmac("sha1", `${accessKeySecret}&`).update(stringToSign).digest("base64");
}

export async function sendSms(
  phone: string,
  code: string,
): Promise<SmsResult> {
  const accessKeyId = process.env.SMS_ACCESS_KEY_ID;
  const accessKeySecret = process.env.SMS_ACCESS_KEY_SECRET;
  const signName = process.env.SMS_SIGN_NAME;
  const templateCode = process.env.SMS_TEMPLATE_CODE;
  if (!accessKeyId || !accessKeySecret || !signName || !templateCode) {
    console.log(`[SMS] ===== 验证码 =====`);
    console.log(`[SMS] 手机号: ${phone}`);
    console.log(`[SMS] 验证码: ${code}`);
    console.log(`[SMS] ==================`);
    return { success: true, messageId: "dev-fallback" };
  }

  const paramName = process.env.SMS_TEMPLATE_PARAM || "code";
  const params: Record<string, string> = {
    AccessKeyId: accessKeyId,
    Action: "SendSms",
    Format: "JSON",
    RegionId: "cn-hangzhou",
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: randomUUID(),
    SignatureVersion: "1.0",
    // ISO8601 UTC（去掉毫秒，阿里云要求 yyyy-MM-ddTHH:mm:ssZ）
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    Version: API_VERSION,
    PhoneNumbers: phone,
    SignName: signName,
    TemplateCode: templateCode,
    TemplateParam: JSON.stringify({ [paramName]: code }),
  };

  try {
    const signature = buildSignature(params, accessKeySecret);
    // 线上查询串用与签名同一套 percentEncode + 按键排序，保证线上编码与签名一致
    const query = Object.entries({ ...params, Signature: signature })
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${percentEncode(k)}=${percentEncode(v)}`)
      .join("&");
    const res = await fetch(`${ENDPOINT}?${query}`);
    const text = await res.text();
    const data = JSON.parse(text) as {
      Code?: string;
      Message?: string;
      BizId?: string;
    };
    if (data.Code === "OK") {
      return { success: true, messageId: data.BizId };
    }
    return {
      success: false,
      error: `阿里云返回 ${data.Code ?? "未知"}: ${data.Message ?? ""}`.trim(),
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[SMS] 发送失败:", msg);
    return { success: false, error: msg };
  }
}
