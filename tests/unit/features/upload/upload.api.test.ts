// upload.api 单元测试 — POST /api/upload（multipart/form-data，手动解析）
// mock 系统边界：authenticateUser + uploadImage
// 契约：
// - 需登录（401）；文件缺失 / MIME 白名单外 / 空文件 / >4MB → 422
// - purpose 仅允许 product/brand → 其它 422
// - service 未配置 → 503 STORAGE_NOT_CONFIGURED；成功 → 201 含 url/key

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/shared/api/auth", () => ({
  authenticateUser: vi.fn(),
}));

vi.mock("@/features/upload/upload.service", () => ({
  uploadImage: vi.fn(),
}));

import { AppError, ERROR_CODES } from "@/shared/errors/errors";
import { authenticateUser } from "@/shared/api/auth";
import { uploadImage } from "@/features/upload/upload.service";
import { uploadFile } from "@/features/upload/upload.api";

const authMock = vi.mocked(authenticateUser);
const uploadMock = vi.mocked(uploadImage);

const MAX = 4 * 1024 * 1024;

function makeRequest(form: FormData): Request {
  return new Request("http://localhost/api/upload", { method: "POST", body: form });
}

function imageForm(mime = "image/jpeg", size = 3, purpose = "product"): FormData {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(size)], "a.jpg", { type: mime }));
  form.append("purpose", purpose);
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ userId: "user-1", role: "USER" });
});

describe("POST /api/upload", () => {
  it("未登录 → 401 UNAUTHORIZED", async () => {
    authMock.mockRejectedValue(new AppError(ERROR_CODES.UNAUTHORIZED, "请先登录"));

    const res = await uploadFile(makeRequest(imageForm()));

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "UNAUTHORIZED" });
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("缺 file 字段 → 422 VALIDATION_ERROR", async () => {
    const form = new FormData();
    form.append("purpose", "product");

    const res = await uploadFile(makeRequest(form));

    expect(res.status).toBe(422);
  });

  it("MIME 不在白名单（application/octet-stream）→ 422", async () => {
    const res = await uploadFile(makeRequest(imageForm("application/octet-stream")));

    expect(res.status).toBe(422);
  });

  it("超过 4MB → 422", async () => {
    const res = await uploadFile(makeRequest(imageForm("image/jpeg", MAX + 1)));

    expect(res.status).toBe(422);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("purpose 非法（banner）→ 422", async () => {
    const res = await uploadFile(makeRequest(imageForm("image/jpeg", 3, "banner")));

    expect(res.status).toBe(422);
  });

  it("service 抛未配置 → 503 STORAGE_NOT_CONFIGURED", async () => {
    uploadMock.mockRejectedValue(
      new AppError(ERROR_CODES.STORAGE_NOT_CONFIGURED, "存储未配置，缺少环境变量: OSS_ACCESS_KEY_ID"),
    );

    const res = await uploadFile(makeRequest(imageForm()));

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "STORAGE_NOT_CONFIGURED" });
  });

  it("成功 → 201 返回 {success, url, key}，service 收到服务端 userId 注入的 folder/mime/buffer", async () => {
    uploadMock.mockResolvedValue({
      url: "https://img.example.com/product/user-1/20260814/a.jpg",
      key: "product/user-1/20260814/a.jpg",
    });

    const res = await uploadFile(makeRequest(imageForm("image/jpeg", 3, "product")));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.url).toContain("img.example.com");
    expect(body.key).toContain("product/user-1/");

    expect(uploadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        folder: "product",
        mime: "image/jpeg",
      }),
    );
  });
});
