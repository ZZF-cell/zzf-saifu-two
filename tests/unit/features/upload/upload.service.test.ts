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
import { uploadImage } from "@/features/upload/upload.service";

const reasonMock = vi.mocked(ossAdapter.getUnavailableReason);
const putMock = vi.mocked(ossAdapter.putObject);

const INPUT = {
  folder: "product",
  userId: "user-1",
  mime: "image/jpeg" as const,
  buffer: Buffer.from("fake-image-bytes"),
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
});
