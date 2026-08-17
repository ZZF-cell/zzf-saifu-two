// CSRF Origin 校验单元测试（E3）
// 契约：带 Origin 的请求必须属于本站（NEXT_PUBLIC_BASE_URL origin / 非生产 localhost），
// 跨站请求拒绝；无 Origin 的请求（curl、服务端调用如支付宝回调）放行，不误伤合法调用。
// 只测公共 seam：isAllowedOrigin + withValidation 的 CSRF 拦截路径

import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";
import { NextResponse } from "next/server";
import { isAllowedOrigin, withValidation } from "@/shared/utils/api";

const BASE_URL = "https://saifu.e9888.cn";

beforeEach(() => {
  vi.restoreAllMocks();
  process.env.NEXT_PUBLIC_BASE_URL = BASE_URL;
  (process.env as Record<string, string | undefined>).NODE_ENV = "test";
});

describe("isAllowedOrigin — Origin 比对规则", () => {
  it("无 Origin 头 → 放行（curl / 服务端到服务端调用）", () => {
    const req = new Request(`${BASE_URL}/api/auth/login`, { method: "POST" });
    expect(isAllowedOrigin(req)).toBe(true);
  });

  it("Origin 匹配 NEXT_PUBLIC_BASE_URL → 放行", () => {
    const req = new Request(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { origin: BASE_URL },
    });
    expect(isAllowedOrigin(req)).toBe(true);
  });

  it("非生产环境 Origin = http://localhost:3000 → 放行（本地联调）", () => {
    const req = new Request(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { origin: "http://localhost:3000" },
    });
    expect(isAllowedOrigin(req)).toBe(true);
  });

  it("Origin 为攻击站点 → 拒绝", () => {
    const req = new Request(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { origin: "https://evil.example.com" },
    });
    expect(isAllowedOrigin(req)).toBe(false);
  });

  it("生产环境 Origin = localhost → 拒绝（localhost 仅非生产白名单）", () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    const req = new Request(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { origin: "http://localhost:3000" },
    });
    expect(isAllowedOrigin(req)).toBe(false);
  });

  it("NEXT_PUBLIC_BASE_URL 未配置 → 仅非生产 localhost 放行，其他拒绝", () => {
    delete process.env.NEXT_PUBLIC_BASE_URL;
    const allowed = new Request(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { origin: "http://localhost:3000" },
    });
    expect(isAllowedOrigin(allowed)).toBe(true);
    const denied = new Request(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { origin: BASE_URL },
    });
    expect(isAllowedOrigin(denied)).toBe(false);
  });
});

describe("withValidation — CSRF Origin 拦截", () => {
  const schema = z.object({});
  const handler = vi.fn(async () => NextResponse.json({ success: true }));
  const wrapped = withValidation(schema, handler);

  beforeEach(() => {
    handler.mockClear();
  });

  it("带非法 Origin → 403 CSRF_INVALID，handler 不被调用", async () => {
    const req = new Request(`${BASE_URL}/api/test`, {
      method: "POST",
      headers: { origin: "https://evil.example.com" },
      body: "{}",
    });
    const res = await wrapped(req);

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "CSRF_INVALID" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("无 Origin → 正常处理（服务端调用不误伤）", async () => {
    const req = new Request(`${BASE_URL}/api/test`, {
      method: "POST",
      body: "{}",
    });
    const res = await wrapped(req);

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("带本站 Origin → 正常处理", async () => {
    const req = new Request(`${BASE_URL}/api/test`, {
      method: "POST",
      headers: { origin: BASE_URL },
      body: "{}",
    });
    const res = await wrapped(req);

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
