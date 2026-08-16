// realname.adapter 单元测试 — 实名认证适配器占位
// - isValidIdNumber：身份证号格式校验纯函数
// - getRealNameAdapter：未配置降级（safe default 拒绝） vs 演示模式（REALNAME_MOCK=true）
//   - 未配置不核验：与支付适配器一致，宁可拒绝也不伪造「已核验」
//   - 演示 provider：姓名空 / 证件号格式非法 / 格式合法假定通过
// 用 vi.resetModules() + 动态 import 重建单例：cachedAdapter 是模块级缓存，
// 单例不重建会污染后续用例（与 payment.adapter.test.ts 同模式）

import { describe, it, expect, vi } from "vitest";
import { isValidIdNumber } from "@/shared/adapters/realname.adapter";

// ── 纯函数：身份证号格式 ──

describe("isValidIdNumber — 身份证号格式校验", () => {
  it("18 位纯数字 → 合法", () => {
    expect(isValidIdNumber("110105194912310021")).toBe(true);
  });

  it("末位大写 X → 合法", () => {
    expect(isValidIdNumber("11010519491231002X")).toBe(true);
  });

  it("末位小写 x → 归一化合法", () => {
    expect(isValidIdNumber("11010519491231002x")).toBe(true);
  });

  it("前后空白容忍", () => {
    expect(isValidIdNumber(" 11010519491231002X ")).toBe(true);
  });

  it("17 位 → 非法", () => {
    expect(isValidIdNumber("11010519491231002")).toBe(false);
  });

  it("19 位 → 非法", () => {
    expect(isValidIdNumber("1101051949123100211")).toBe(false);
  });

  it("含非法字符 → 非法", () => {
    expect(isValidIdNumber("11010519491L31002X")).toBe(false);
  });

  it("空字符串 → 非法", () => {
    expect(isValidIdNumber("")).toBe(false);
  });
});

// ── 适配器单例（未配置降级 / 演示模式） ──

async function loadAdapter() {
  vi.resetModules();
  const mod = await import("@/shared/adapters/realname.adapter");
  return mod.getRealNameAdapter();
}

describe("getRealNameAdapter — 未配置降级（safe default）", () => {
  it("未设 REALNAME_MOCK → 受理失败并说明未配置", async () => {
    delete process.env.REALNAME_MOCK;
    const adapter = await loadAdapter();
    const res = await adapter.verifyIdentity({
      realName: "张三",
      idNumber: "11010519491231002X",
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain("未配置");
  });

  it("REALNAME_MOCK 非 'true'（如 '0'）→ 同样视为未配置降级", async () => {
    process.env.REALNAME_MOCK = "0";
    const adapter = await loadAdapter();
    const res = await adapter.verifyIdentity({
      realName: "张三",
      idNumber: "11010519491231002X",
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain("未配置");
  });
});

describe("getRealNameAdapter — 演示模式（REALNAME_MOCK=true）", () => {
  it("姓名为空 → 受理失败并说明姓名不能为空", async () => {
    process.env.REALNAME_MOCK = "true";
    const adapter = await loadAdapter();
    const res = await adapter.verifyIdentity({ realName: "  ", idNumber: "11010519491231002X" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("姓名不能为空");
  });

  it("身份证号格式非法 → matched:false 拒绝", async () => {
    process.env.REALNAME_MOCK = "true";
    const adapter = await loadAdapter();
    const res = await adapter.verifyIdentity({ realName: "张三", idNumber: "12345" });
    expect(res.success).toBe(false);
    expect(res.matched).toBe(false);
  });

  it("姓名 + 合法证件号 → 演示通过（matched:true）", async () => {
    process.env.REALNAME_MOCK = "true";
    const adapter = await loadAdapter();
    const res = await adapter.verifyIdentity({
      realName: "张三",
      idNumber: "11010519491231002X",
    });
    expect(res.success).toBe(true);
    expect(res.matched).toBe(true);
    expect(res.message).toContain("演示模式");
  });
});
