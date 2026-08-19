// sms.adapter.sendSms 单元测试
// - 未配置密钥 / 缺签名或模板 → dev-fallback（验证码仅终端日志，不发请求）
// - 配置齐全 → 真实发送：RPC 签名 + GET dysmsapi.aliyuncs.com，Code=OK → messageId=BizId
// - 业务失败码 / fetch 抛错 → success:false 优雅降级
// - percentEncode 编码规则（RFC3986，阿里云 RPC 签名专用：+→%20、*→%2A、%7E→~）
//
// 断言注记：签名串本身不在此与实现互相验证（避免自证恒真）；用独立字面量锁定
// 编码规则 + 请求线格式（参数排序/必需公共参数/唯一 nonce），签名对错的最终裁决
// 由配好真实密钥后的线上实测承担。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sendSms, percentEncode } from "@/shared/adapters/sms.adapter";

const ENDPOINT = "https://dysmsapi.aliyuncs.com/?";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal("fetch", vi.fn());
  process.env.SMS_ACCESS_KEY_ID = "LTAI5t_example";
  process.env.SMS_ACCESS_KEY_SECRET = "exampleSecret";
  process.env.SMS_SIGN_NAME = "赛夫严选";
  process.env.SMS_TEMPLATE_CODE = "SMS_123456789";
  delete process.env.SMS_TEMPLATE_PARAM;
  delete process.env.SMS_BACKEND;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SMS_ACCESS_KEY_ID;
  delete process.env.SMS_ACCESS_KEY_SECRET;
  delete process.env.SMS_SIGN_NAME;
  delete process.env.SMS_TEMPLATE_CODE;
  delete process.env.SMS_TEMPLATE_PARAM;
  delete process.env.SMS_BACKEND;
});

/** 捕获最后一次 fetch 的 URL，解析成查询参数 Map（值保持线上原始百分号编码形态） */
function captureQuery() {
  const url = vi.mocked(fetch).mock.calls.at(-1)?.[0] as string;
  const q = url.split("?")[1] ?? "";
  return new Map(q.split("&").map((kv) => {
    const i = kv.indexOf("=");
    return [decodeURIComponent(kv.slice(0, i)), kv.slice(i + 1)];
  }));
}

/** 捕获最后一次 fetch 的 URL，键值均解码（用于校验语义，非线上形态） */
function captureDecodedQuery() {
  const q = captureQuery();
  return new Map([...q].map(([k, v]) => [k, decodeURIComponent(v)]));
}

describe("percentEncode — RFC3986 编码规则", () => {
  it("按阿里云规范：空格→%20、*→%2A、~ 还原、/ →%2F", () => {
    expect(percentEncode("a b*c~d/")).toBe("a%20b%2Ac~d%2F");
  });

  it("JSON 模板参数按规范编码（{ } 引号 冒号 逗号 全转义）", () => {
    expect(percentEncode('{"code":"1234"}')).toBe("%7B%22code%22%3A%221234%22%7D");
  });
});

describe("sendSms — 未配置时的 dev-fallback 降级", () => {
  it("无密钥 → dev-fallback，不发任何请求", async () => {
    delete process.env.SMS_ACCESS_KEY_ID;
    const r = await sendSms("13800000000", "123456");
    expect(r).toEqual({ success: true, messageId: "dev-fallback" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("密钥齐但缺签名 → dev-fallback", async () => {
    delete process.env.SMS_SIGN_NAME;
    const r = await sendSms("13800000000", "123456");
    expect(r.messageId).toBe("dev-fallback");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("密钥齐但缺模板 Code → dev-fallback", async () => {
    delete process.env.SMS_TEMPLATE_CODE;
    const r = await sendSms("13800000000", "123456");
    expect(r.messageId).toBe("dev-fallback");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("sendSms — 配置齐全时的真实发送", () => {
  it("Code=OK → success + messageId=BizId", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ Code: "OK", Message: "OK", BizId: "biz-123" }),
    } as Response);

    const r = await sendSms("13800000000", "654321");
    expect(r).toEqual({ success: true, messageId: "biz-123" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("请求线格式：GET 端点 + 全部公共参数 + 手机号/签名/模板 + JSON 模板参数已编码", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ Code: "OK", Message: "OK", BizId: "biz" }),
    } as Response);

    await sendSms("13800000000", "654321");
    const url = vi.mocked(fetch).mock.calls[0][0] as string;
    expect(url.startsWith(ENDPOINT)).toBe(true);

    const q = captureQuery();
    const dq = captureDecodedQuery();
    // 必需公共参数（语义校验用解码值；线上形态另有百分号编码断言）
    expect(dq.get("Action")).toBe("SendSms");
    expect(dq.get("Format")).toBe("JSON");
    expect(dq.get("RegionId")).toBe("cn-hangzhou");
    expect(dq.get("SignatureMethod")).toBe("HMAC-SHA1");
    expect(dq.get("SignatureVersion")).toBe("1.0");
    expect(dq.get("Version")).toBe("2017-05-25");
    expect(dq.get("AccessKeyId")).toBe("LTAI5t_example");
    expect(dq.get("Timestamp")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    // 业务参数
    expect(dq.get("PhoneNumbers")).toBe("13800000000");
    expect(dq.get("SignName")).toBe("赛夫严选");
    expect(dq.get("TemplateCode")).toBe("SMS_123456789");
    // 线上形态：JSON 模板参数百分号编码（{ } 引号 冒号 逗号 全转义）
    expect(q.get("TemplateParam")).toBe("%7B%22code%22%3A%22654321%22%7D");
    // 签名存在
    const sig = q.get("Signature") ?? "";
    expect(sig.length).toBeGreaterThan(20);
  });

  it("参数按键名排序（签名规范要求）；两次请求 SignatureNonce 唯一", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ Code: "OK", Message: "OK", BizId: "b" }),
    } as Response);

    await sendSms("13800000000", "111111");
    await sendSms("13800000000", "222222");

    const q1 = captureQuery();
    // 第二次调用后 capture 到的是第二次；分别取两次的 nonce 对比唯一性
    const [u1, u2] = vi.mocked(fetch).mock.calls.map(
      (c) => new Map((c[0] as string).split("?")[1].split("&").map((kv) => {
        const i = kv.indexOf("=");
        return [decodeURIComponent(kv.slice(0, i)), kv.slice(i + 1)];
      })).get("SignatureNonce"),
    );
    expect(u1).toBeTruthy();
    expect(u2).toBeTruthy();
    expect(u1).not.toBe(u2);

    // 排序：query 中键按字典序出现（percentEncode 后的键序与原始键字典序一致）
    const keys = [...q1.keys()];
    expect(keys).toEqual([...keys].sort());
  });

  it("模板变量名可用 SMS_TEMPLATE_PARAM 覆盖", async () => {
    process.env.SMS_TEMPLATE_PARAM = "verifyCode";
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ Code: "OK", Message: "OK", BizId: "b" }),
    } as Response);

    await sendSms("13800000000", "123456");
    const q = captureQuery();
    expect(q.get("TemplateParam")).toBe("%7B%22verifyCode%22%3A%22123456%22%7D");
  });
});

describe("sendSms — 业务失败与网络异常降级", () => {
  it("阿里云返回非 OK（如 SignatureDoesNotMatch）→ success:false + 错误信息", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({ Code: "SignatureDoesNotMatch", Message: "签名不对", BizId: "" }),
    } as Response);

    const r = await sendSms("13800000000", "123456");
    expect(r.success).toBe(false);
    expect(r.error).toContain("SignatureDoesNotMatch");
  });

  it("fetch 抛错 → success:false 优雅降级，不抛未处理异常", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("ENOTFOUND dysmsapi.aliyuncs.com"));
    const r = await sendSms("13800000000", "123456");
    expect(r.success).toBe(false);
    expect(r.error).toContain("ENOTFOUND");
  });

  it("响应非合法 JSON → success:false 降级", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      text: async () => "<html>error</html>",
    } as Response);
    const r = await sendSms("13800000000", "123456");
    expect(r.success).toBe(false);
  });
});

describe("sendSms — dypns 验证码专用通道（SMS_BACKEND=dypns-send-verify-code）", () => {
  // 默认模式（send-sms）之外的第二通道：SendSmsVerifyCode（号码认证服务-短信认证）。
  // 验证码由阿里云生成（占位符模式），ReturnVerifyCode=true 回传 → 调用方存哈希自核验。
  beforeEach(() => {
    process.env.SMS_BACKEND = "dypns-send-verify-code";
  });
  afterEach(() => {
    delete process.env.SMS_BACKEND;
  });

  it("无密钥 → dev-fallback，回传调用方验证码（供自核验），不发任何请求", async () => {
    delete process.env.SMS_ACCESS_KEY_ID;
    const r = await sendSms("13800000000", "123456");
    expect(r).toEqual({ success: true, code: "123456", messageId: "dev-fallback" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("Code=OK + Model.VerifyCode → success + code（阿里云生成码）+ messageId=RequestId", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({ Code: "OK", Message: "OK", RequestId: "req-1", Model: { VerifyCode: "654321" } }),
    } as Response);

    const r = await sendSms("13800000000", "local-ignored");
    expect(r).toEqual({ success: true, code: "654321", messageId: "req-1" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("请求线：GET dypnsapi 端点 + SendSmsVerifyCode 业务参数（占位符不传 TemplateParam、CodeLength=6/ValidTime=300/DuplicatePolicy=1/ReturnVerifyCode=true）", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({ Code: "OK", Message: "OK", RequestId: "req", Model: { VerifyCode: "123456" } }),
    } as Response);

    await sendSms("13800000000", "ignored");
    const url = vi.mocked(fetch).mock.calls[0][0] as string;
    expect(url.startsWith("https://dypnsapi.aliyuncs.com/?")).toBe(true);

    const dq = captureDecodedQuery();
    // 公共参数沿用（与 send-sms 同签名机制）
    expect(dq.get("Version")).toBe("2017-05-25");
    // 业务参数
    expect(dq.get("Action")).toBe("SendSmsVerifyCode");
    expect(dq.get("PhoneNumber")).toBe("13800000000");
    expect(dq.get("SignName")).toBe("赛夫严选");
    expect(dq.get("TemplateCode")).toBe("SMS_123456789");
    expect(dq.get("CodeLength")).toBe("6");
    expect(dq.get("ValidTime")).toBe("300");
    expect(dq.get("DuplicatePolicy")).toBe("1");
    expect(dq.get("ReturnVerifyCode")).toBe("true");
    // 占位符模式（TemplateParam 必填）：##code## 由阿里云生成验证码（实测缺参会 MissingTemplateParam）
    expect(dq.get("TemplateParam")).toBe('{"code":"##code##","min":"5"}');
    // 线上形态：JSON 模板参数百分号编码
    expect(captureQuery().get("TemplateParam")).toBe(
      "%7B%22code%22%3A%22%23%23code%23%23%22%2C%22min%22%3A%225%22%7D",
    );
    // 签名存在
    const sig = captureQuery().get("Signature") ?? "";
    expect(sig.length).toBeGreaterThan(20);
  });

  it("Code=OK 但未回传 VerifyCode → success:false（拒绝静默无码）", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ Code: "OK", Message: "OK", RequestId: "req", Model: {} }),
    } as Response);

    const r = await sendSms("13800000000", "123456");
    expect(r.success).toBe(false);
  });

  it("阿里云返回非 OK（如未开通短信认证）→ success:false + 错误信息", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({ Code: "isv.SMS_SIGNATURE_ILLEGAL", Message: "未开通短信认证", RequestId: "req" }),
    } as Response);

    const r = await sendSms("13800000000", "123456");
    expect(r.success).toBe(false);
    expect(r.error).toContain("isv.SMS_SIGNATURE_ILLEGAL");
  });

  it("fetch 抛错 → success:false 优雅降级", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("ENOTFOUND dypnsapi.aliyuncs.com"));
    const r = await sendSms("13800000000", "123456");
    expect(r.success).toBe(false);
    expect(r.error).toContain("ENOTFOUND");
  });
});
