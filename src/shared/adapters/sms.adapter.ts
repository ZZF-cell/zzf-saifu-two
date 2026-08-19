// 阿里云短信适配器 — 双产品通道（SMS_BACKEND 切换，RPC 风格，HMAC-SHA1 签名）
//
// 1) send-sms（默认，向后兼容）→ 短信服务 Dysmsapi SendSms
//    端点 https://dysmsapi.aliyuncs.com/，验证码由调用方生成、经模板变量传入
// 2) dypns-send-verify-code → 号码认证服务-短信认证 Dypnsapi SendSmsVerifyCode
//    端点 https://dypnsapi.aliyuncs.com/（国内版固定，切换地域不影响短信接收）
//    「验证码专用」通道：系统赠送签名/模板（敏感行业可免自定义签名审核）
//    验证码由阿里云生成（占位符模式），ReturnVerifyCode=true 回传 → 调用方存哈希自核验
//
// 真实发送依赖环境变量（任一缺失 → 回退 dev-fallback，验证码仅终端日志，供本地/验收）：
//   SMS_BACKEND                            通道：send-sms（默认）/ dypns-send-verify-code
//   SMS_ACCESS_KEY_ID / SMS_ACCESS_KEY_SECRET  阿里云 AccessKey（dypns 通道需授权 AliyunDypnsFullAccess）
//   SMS_SIGN_NAME                          短信签名（dypns 通道 = 控制台系统赠送签名名称）
//   SMS_TEMPLATE_CODE                      短信模板 Code（dypns 通道 = 系统赠送模板如 100001）
//   SMS_TEMPLATE_PARAM                     （可选，仅 send-sms）模板变量名，默认 code
//
// 协议（阿里云官方公共参数 + 签名机制，V2017-05-25，两个产品一致）：
//   GET <endpoint>/?<公共参数 + 业务参数 + Signature>
//   签名 = base64( HMAC-SHA1( AccessKeySecret + "&", "GET&%2F&" + percentEncode(规范化查询串) ) )
//   规范化查询串 = 全部参数按键名字典序排列，每对 percentEncode(key)=percentEncode(value) 用 & 连接
//   成功判定：响应 Code === "OK"

import { createHmac, randomUUID } from "node:crypto";

const DYSMSAPI_ENDPOINT = "https://dysmsapi.aliyuncs.com/"; // 短信服务
const DYPNSAPI_ENDPOINT = "https://dypnsapi.aliyuncs.com/"; // 号码认证服务-短信认证
const API_VERSION = "2017-05-25";
const REGION_ID = "cn-hangzhou";

export interface SmsResult {
  success: boolean;
  /** 实际用于核验的验证码：dypns 通道由阿里云生成回传（ReturnVerifyCode=true）；其余通道为 undefined（调用方用自己的 code） */
  code?: string;
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

/** 公共参数 + 业务参数 → 签名 → GET 请求 → 解析 JSON 响应 */
async function rpcRequest(
  endpoint: string,
  bizParams: Record<string, string>,
  accessKeyId: string,
  accessKeySecret: string,
): Promise<Record<string, unknown>> {
  const params: Record<string, string> = {
    AccessKeyId: accessKeyId,
    Format: "JSON",
    RegionId: REGION_ID,
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: randomUUID(),
    SignatureVersion: "1.0",
    // ISO8601 UTC（去掉毫秒，阿里云要求 yyyy-MM-ddTHH:mm:ssZ）
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    Version: API_VERSION,
    ...bizParams,
  };
  const signature = buildSignature(params, accessKeySecret);
  // 线上查询串用与签名同一套 percentEncode + 按键排序，保证线上编码与签名一致
  const query = Object.entries({ ...params, Signature: signature })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${percentEncode(k)}=${percentEncode(v)}`)
    .join("&");
  const res = await fetch(`${endpoint}?${query}`);
  return JSON.parse(await res.text()) as Record<string, unknown>;
}

/** 适配器入口：按 SMS_BACKEND 选择产品通道 */
export async function sendSms(phone: string, code: string): Promise<SmsResult> {
  if (process.env.SMS_BACKEND === "dypns-send-verify-code") {
    return sendSmsVerifyCode(phone, code);
  }
  return sendSmsViaDysmsapi(phone, code);
}

// ── 通道一：短信服务 SendSms（默认） ──

async function sendSmsViaDysmsapi(phone: string, code: string): Promise<SmsResult> {
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
  try {
    const data = (await rpcRequest(
      DYSMSAPI_ENDPOINT,
      {
        Action: "SendSms",
        PhoneNumbers: phone,
        SignName: signName,
        TemplateCode: templateCode,
        TemplateParam: JSON.stringify({ [paramName]: code }),
      },
      accessKeyId,
      accessKeySecret,
    )) as { Code?: string; Message?: string; BizId?: string };
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

// ── 通道二：号码认证服务-短信认证 SendSmsVerifyCode（验证码专用通道） ──

async function sendSmsVerifyCode(phone: string, fallbackCode: string): Promise<SmsResult> {
  const accessKeyId = process.env.SMS_ACCESS_KEY_ID;
  const accessKeySecret = process.env.SMS_ACCESS_KEY_SECRET;
  const signName = process.env.SMS_SIGN_NAME;
  const templateCode = process.env.SMS_TEMPLATE_CODE;
  if (!accessKeyId || !accessKeySecret || !signName || !templateCode) {
    // dev-fallback：无真实通道，验证码仅终端日志（用调用方本地生成的码，后续存哈希自核验）
    console.log(`[SMS] ===== 验证码 =====`);
    console.log(`[SMS] 手机号: ${phone}`);
    console.log(`[SMS] 验证码: ${fallbackCode}`);
    console.log(`[SMS] ==================`);
    return { success: true, code: fallbackCode, messageId: "dev-fallback" };
  }

  try {
    // 占位符模式（默认 mode 1，不传 TemplateParam）：
    //   验证码由阿里云生成 → ReturnVerifyCode=true 使响应 Model.VerifyCode 回传，
    //   调用方存哈希自核验 —— 阿里云端可校验，最符合「验证码专用」通道语义。
    // 业务参数：CodeLength=6（保持现有 6 位验证码交互）、ValidTime=300（5 分钟，与 DB TTL 一致）、
    //   DuplicatePolicy=1（新码覆盖旧码，同号只留最新）、不传 Interval（阿里云端 60s 限流兜底）
    const data = (await rpcRequest(
      DYPNSAPI_ENDPOINT,
      {
        Action: "SendSmsVerifyCode",
        PhoneNumber: phone,
        SignName: signName,
        TemplateCode: templateCode,
        CodeLength: "6",
        ValidTime: "300",
        DuplicatePolicy: "1",
        ReturnVerifyCode: "true",
      },
      accessKeyId,
      accessKeySecret,
    )) as { Code?: string; Message?: string; RequestId?: string; Model?: { VerifyCode?: string } };
    if (data.Code === "OK") {
      const verifyCode = data.Model?.VerifyCode;
      if (!verifyCode) {
        // 理论不达（已开 ReturnVerifyCode）；拒绝静默无码，宁可报错让调用方走降级/告警
        return { success: false, error: "SendSmsVerifyCode 返回 OK 但未回传验证码" };
      }
      return { success: true, code: verifyCode, messageId: data.RequestId ?? "ok" };
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
