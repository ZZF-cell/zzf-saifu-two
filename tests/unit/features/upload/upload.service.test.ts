// upload.service 单元测试 — 文件 → OSS → URL（CQS 只写）
// mock 系统边界：ossAdapter 单例（仿 payment.service.test）
// 契约：
// - 未配置 OSS → 先行抛 503 STORAGE_NOT_CONFIGURED，绝不调 putObject（决策：未配置返回失败标记）
// - adapter 运行期失败 → 抛 502 UPLOAD_FAILED 透传错误
// - 成功 → 返回 {url, key}，putObject 收到服务端注入的 folder/userId/mime/buffer

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/shared/adapters/oss.adapter", () => ({
  ossAdapter: {
    getUnavailableReason: vi.fn(),
    putObject: vi.fn(),
  },
}));

import { ERROR_CODES } from "@/shared/errors/errors";
import { ossAdapter } from "@/shared/adapters/oss.adapter";
import { uploadImage, assertValidMagicBytes } from "@/features/upload/upload.service";

const reasonMock = vi.mocked(ossAdapter.getUnavailableReason);
const putMock = vi.mocked(ossAdapter.putObject);

/** 合法 JPEG 文件头（FF D8 FF）：L14 魔数校验通过的最小字节 */
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const WEBP_HEAD = Buffer.from("RIFFxxxxWEBP", "ascii");
const PDF_HEAD = Buffer.from("%PDF-1.4\n", "ascii");

const INPUT = {
  folder: "product",
  userId: "user-1",
  mime: "image/jpeg" as const,
  buffer: JPEG_HEAD,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("uploadImage — 图片上传服务", () => {
  it("OSS 未配置 → 抛 503 STORAGE_NOT_CONFIGURED（透传缺变量文案），不调 putObject", async () => {
    reasonMock.mockReturnValue("存储未配置，缺少环境变量: OSS_ACCESS_KEY_ID");
    putMock.mockResolvedValue({ success: true, url: "x", key: "y" });

    await expect(uploadImage(INPUT)).rejects.toMatchObject({
      code: ERROR_CODES.STORAGE_NOT_CONFIGURED.code,
      statusCode: 503,
      message: "存储未配置，缺少环境变量: OSS_ACCESS_KEY_ID",
    });
    expect(putMock).not.toHaveBeenCalled();
  });

  it("adapter 上传失败 → 抛 502 UPLOAD_FAILED，透传 OSS 错误", async () => {
    reasonMock.mockReturnValue(null);
    putMock.mockResolvedValue({ success: false, error: "NoSuchKey: bucket not found" });

    await expect(uploadImage(INPUT)).rejects.toMatchObject({
      code: ERROR_CODES.UPLOAD_FAILED.code,
      statusCode: 502,
      message: "NoSuchKey: bucket not found",
    });
  });

  it("上传成功 → 返回 {url, key}，putObject 收到 server 侧注入的 folder/userId/mime/buffer", async () => {
    reasonMock.mockReturnValue(null);
    putMock.mockResolvedValue({
      success: true,
      url: "https://img.example.com/product/user-1/20260814/a.jpg",
      key: "product/user-1/20260814/a.jpg",
    });

    const result = await uploadImage(INPUT);

    expect(result).toEqual({
      url: "https://img.example.com/product/user-1/20260814/a.jpg",
      key: "product/user-1/20260814/a.jpg",
    });
    expect(putMock).toHaveBeenCalledWith(INPUT);
  });

  it("L14：内容魔数与声明的 MIME 不符 → 422 VALIDATION_ERROR，绝不调 putObject", async () => {
    reasonMock.mockReturnValue(null);
    // 攻击者把 HTML 改名 image.png 上传（file.type 由客户端伪造），
    // 魔数校验是最后防线：HTML 内容 ≠ PNG 头 → 拒绝，防止存储型 XSS
    const fakePng = Buffer.from("<html><script>alert(1)</script></html>");

    await expect(uploadImage({ ...INPUT, mime: "image/png", buffer: fakePng })).rejects.toMatchObject({
      code: ERROR_CODES.VALIDATION_ERROR.code,
      statusCode: 422,
      message: "文件内容与声明的类型不符，请重新上传",
    });
    expect(putMock).not.toHaveBeenCalled();
  });
});

// ── L14 魔数校验（纯函数） ──

describe("assertValidMagicBytes — 文件头魔数核对", () => {
  it("JPEG 头匹配 → 通过", () => {
    expect(() => assertValidMagicBytes("image/jpeg", JPEG_HEAD)).not.toThrow();
  });

  it("PNG 头匹配 → 通过", () => {
    expect(() => assertValidMagicBytes("image/png", PNG_HEAD)).not.toThrow();
  });

  it("WebP 头匹配 → 通过", () => {
    expect(() => assertValidMagicBytes("image/webp", WEBP_HEAD)).not.toThrow();
  });

  it("PDF 头匹配 → 通过", () => {
    expect(() => assertValidMagicBytes("application/pdf", PDF_HEAD)).not.toThrow();
  });

  it("PNG 内容声明为 PDF → 拒绝（PDF 头必须 %PDF-）", () => {
    expect(() => assertValidMagicBytes("application/pdf", PNG_HEAD)).toThrow();
  });

  it("HTML 内容声明为 PNG → 拒绝（存储型 XSS 防护）", () => {
    const html = Buffer.from("<script>alert(1)</script>", "ascii");
    expect(() => assertValidMagicBytes("image/png", html)).toThrow();
  });

  it("字节数不足 → 拒绝（空文件/截断头）", () => {
    expect(() => assertValidMagicBytes("image/jpeg", Buffer.from([0xff, 0xd8]))).toThrow();
    expect(() => assertValidMagicBytes("image/png", Buffer.alloc(0))).toThrow();
  });
});
