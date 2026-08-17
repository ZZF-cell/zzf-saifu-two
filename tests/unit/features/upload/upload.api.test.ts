// upload.api 单元测试 — POST /api/upload（multipart/form-data，手动解析）
// mock 系统边界：authenticateUser + uploadImage
// 契约：
// - 需登录（401）；文件缺失 / MIME 白名单外 / 空文件 → 422
// - purpose 仅允许 product/brand/cert → 其它 422
// - product/brand 只收图片（≤4MB）；cert 收图片（≤4MB）+ PDF（≤10MB）
// - service 未配置 → 503 STORAGE_NOT_CONFIGURED；成功 → 201 含 url/key

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/shared/api/auth", () => ({
  authenticateUser: vi.fn(),
}));

vi.mock("@/features/upload/upload.service", () => ({
  uploadImage: vi.fn(),
}));

// G1 配额走 RateLimitBucket 原子桶，mock 掉 DB 边界（默认放行，配额用例单独覆盖）
vi.mock("@/shared/utils/rate-limit", () => ({
  hitRateLimit: vi.fn(),
  hashKey: (v: string) => `h-${v}`,
}));

import { AppError, ERROR_CODES } from "@/shared/errors/errors";
import { authenticateUser } from "@/shared/api/auth";
import { uploadImage } from "@/features/upload/upload.service";
import { hitRateLimit } from "@/shared/utils/rate-limit";
import { uploadFile } from "@/features/upload/upload.api";

const authMock = vi.mocked(authenticateUser);
const uploadMock = vi.mocked(uploadImage);
const rateLimitMock = vi.mocked(hitRateLimit);

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
  // 默认配额放行（count=1 ≤ max）
  rateLimitMock.mockResolvedValue({ count: 1, allowed: true, retryAfterMs: 0 });
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

  it("PDF 证书（purpose=cert）→ 201，service 收到 cert 目录 + pdf MIME", async () => {
    uploadMock.mockResolvedValue({
      url: "https://img.example.com/cert/user-1/20260815/cert001.pdf",
      key: "cert/user-1/20260815/cert001.pdf",
    });
    // G3 cert 仅 BRAND 角色可传
    authMock.mockResolvedValue({ userId: "user-1", role: "BRAND" });

    const res = await uploadFile(makeRequest(imageForm("application/pdf", 5 * 1024 * 1024, "cert")));

    expect(res.status).toBe(201);
    expect(uploadMock).toHaveBeenCalledWith(
      expect.objectContaining({ folder: "cert", mime: "application/pdf", userId: "user-1" }),
    );
  });

  it("PDF 但 purpose=product → 422（商品主图只收图片）", async () => {
    const res = await uploadFile(makeRequest(imageForm("application/pdf", 1000, "product")));

    expect(res.status).toBe(422);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("PDF 超过 10MB（purpose=cert）→ 422", async () => {
    const res = await uploadFile(
      makeRequest(imageForm("application/pdf", 10 * 1024 * 1024 + 1, "cert")),
    );

    expect(res.status).toBe(422);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("图片但超过 4MB（purpose=cert）→ 422（图片上限不因 cert 放宽）", async () => {
    const res = await uploadFile(makeRequest(imageForm("image/jpeg", MAX + 1, "cert")));

    expect(res.status).toBe(422);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("cert 用途 + 图片 → 201（证书也支持图片格式）", async () => {
    uploadMock.mockResolvedValue({
      url: "https://img.example.com/cert/user-1/20260815/a.png",
      key: "cert/user-1/20260815/a.png",
    });
    authMock.mockResolvedValue({ userId: "user-1", role: "BRAND" });

    const res = await uploadFile(makeRequest(imageForm("image/png", 3, "cert")));

    expect(res.status).toBe(201);
    expect(uploadMock).toHaveBeenCalledWith(
      expect.objectContaining({ folder: "cert", mime: "image/png" }),
    );
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

  it("G3：cert 用途 + 非 BRAND 角色（USER）→ 403 FORBIDDEN，不调 service", async () => {
    const res = await uploadFile(makeRequest(imageForm("image/jpeg", 3, "cert")));

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "FORBIDDEN" });
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("G1：今日配额超限（allowed=false）→ 429 RATE_LIMITED，不调 service", async () => {
    rateLimitMock.mockResolvedValue({ count: 101, allowed: false, retryAfterMs: 60_000 });

    const res = await uploadFile(makeRequest(imageForm("image/jpeg", 3, "product")));

    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "RATE_LIMITED" });
    expect(uploadMock).not.toHaveBeenCalled();
    // 配额键按 userId 哈希隔离
    expect(rateLimitMock).toHaveBeenCalledWith(
      "upload:daily",
      "h-user-1",
      expect.objectContaining({ windowMs: 24 * 60 * 60 * 1000, max: 100 }),
    );
  });
});
