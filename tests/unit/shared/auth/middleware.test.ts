// 中间件路由守卫单元测试（M10）
// 纯函数 seam：getRouteGuardDecision(path, authUser)
// 核心契约：已登录但角色不符 → "forbidden"（403），不再跳登录——
// 修复前 BRAND 访问 /admin → 跳登录 → login 页自动回跳 → 无限重定向循环。

import { describe, it, expect } from "vitest";
import { getRouteGuardDecision } from "@/shared/auth/middleware";

const USER = { userId: "u1", role: "USER" as const };
const BRAND = { userId: "b1", role: "BRAND" as const };
const ADMIN = { userId: "a1", role: "ADMIN" as const };
const SUPER = { userId: "s1", role: "SUPER" as const };
const CS = { userId: "c1", role: "CUSTOMER_SERVICE" as const };
const QI = { userId: "q1", role: "QUALITY_INSPECTOR" as const };

describe("getRouteGuardDecision — 路由权限决策", () => {
  it("未登录访问 /admin → login（引导登录）", () => {
    expect(getRouteGuardDecision("/admin/products", null)).toBe("login");
  });

  it("M10：BRAND 访问 /admin → forbidden（403，不再跳登录防循环）", () => {
    expect(getRouteGuardDecision("/admin", BRAND)).toBe("forbidden");
  });

  it("M10：USER 访问 /admin → forbidden", () => {
    expect(getRouteGuardDecision("/admin", USER)).toBe("forbidden");
  });

  it("ADMIN 访问 /admin → allow", () => {
    expect(getRouteGuardDecision("/admin", ADMIN)).toBe("allow");
  });

  it("SUPER 访问 /admin → allow（最高权限者可进管理后台）", () => {
    expect(getRouteGuardDecision("/admin", SUPER)).toBe("allow");
  });

  it("CUSTOMER_SERVICE 访问 /admin → forbidden（客服走 /service，与管理后台隔离）", () => {
    expect(getRouteGuardDecision("/admin", CS)).toBe("forbidden");
  });

  it("未登录访问 /service → login", () => {
    expect(getRouteGuardDecision("/service", null)).toBe("login");
  });

  it("CUSTOMER_SERVICE 访问 /service → allow", () => {
    expect(getRouteGuardDecision("/service/tickets", CS)).toBe("allow");
  });

  it("SUPER 访问 /service → allow（可监督客服工作台）", () => {
    expect(getRouteGuardDecision("/service", SUPER)).toBe("allow");
  });

  it("M10：USER 访问 /service → forbidden", () => {
    expect(getRouteGuardDecision("/service", USER)).toBe("forbidden");
  });

  it("M10：ADMIN 访问 /service → forbidden（管理员走 /admin）", () => {
    expect(getRouteGuardDecision("/service", ADMIN)).toBe("forbidden");
  });

  it("未登录访问 /inspect → login", () => {
    expect(getRouteGuardDecision("/inspect", null)).toBe("login");
  });

  it("QUALITY_INSPECTOR 访问 /inspect → allow（质检中心专属）", () => {
    expect(getRouteGuardDecision("/inspect/products", QI)).toBe("allow");
  });

  it("SUPER 访问 /inspect → allow（可监督质检）", () => {
    expect(getRouteGuardDecision("/inspect", SUPER)).toBe("allow");
  });

  it("M10：ADMIN 访问 /inspect → forbidden（商品质检与管理员职责隔离）", () => {
    expect(getRouteGuardDecision("/inspect", ADMIN)).toBe("forbidden");
  });

  it("M10：USER 访问 /inspect → forbidden", () => {
    expect(getRouteGuardDecision("/inspect", USER)).toBe("forbidden");
  });

  it("M10：QUALITY_INSPECTOR 访问 /admin → forbidden（质检员走 /inspect）", () => {
    expect(getRouteGuardDecision("/admin", QI)).toBe("forbidden");
  });

  it("未登录访问 /brand → login", () => {
    expect(getRouteGuardDecision("/brand", null)).toBe("login");
  });

  it("M10：ADMIN 访问 /brand → forbidden（品牌方后台仅 BRAND）", () => {
    expect(getRouteGuardDecision("/brand", ADMIN)).toBe("forbidden");
  });

  it("M10：USER 访问 /brand → forbidden", () => {
    expect(getRouteGuardDecision("/brand", USER)).toBe("forbidden");
  });

  it("BRAND 访问 /brand → allow", () => {
    expect(getRouteGuardDecision("/brand", BRAND)).toBe("allow");
  });

  // ── /brands 商家管理（ADMIN + SUPER，与 /brand 品牌方后台隔离） ──

  it("未登录访问 /brands → login", () => {
    expect(getRouteGuardDecision("/brands", null)).toBe("login");
  });

  it("SUPER 访问 /brands → allow（最高权限者商家管理页）", () => {
    expect(getRouteGuardDecision("/brands", SUPER)).toBe("allow");
  });

  it("ADMIN 访问 /brands → allow（管理员商家管理页）", () => {
    expect(getRouteGuardDecision("/brands", ADMIN)).toBe("allow");
  });

  it("M10：BRAND 访问 /brands → forbidden（商家管理是平台侧，商家走 /brand）", () => {
    expect(getRouteGuardDecision("/brands", BRAND)).toBe("forbidden");
  });

  it("M10：USER 访问 /brands → forbidden", () => {
    expect(getRouteGuardDecision("/brands", USER)).toBe("forbidden");
  });

  it("/brands/xxx 子路径同样走商家管理守卫（/brand startsWith 已改精确前缀不误伤）", () => {
    expect(getRouteGuardDecision("/brands/123", BRAND)).toBe("forbidden");
    expect(getRouteGuardDecision("/brands/123", SUPER)).toBe("allow");
  });

  it("未登录访问受保护页（/cart /checkout /orders /account）→ login", () => {
    expect(getRouteGuardDecision("/cart", null)).toBe("login");
    expect(getRouteGuardDecision("/checkout?items=p1", null)).toBe("login");
    expect(getRouteGuardDecision("/orders", null)).toBe("login");
    expect(getRouteGuardDecision("/account", null)).toBe("login");
  });

  it("登录用户访问受保护页 → allow（角色不限，仅要求登录）", () => {
    expect(getRouteGuardDecision("/cart", USER)).toBe("allow");
    expect(getRouteGuardDecision("/orders", BRAND)).toBe("allow");
  });

  it("公开页/首页 → allow（不拦截）", () => {
    expect(getRouteGuardDecision("/", null)).toBe("allow");
    expect(getRouteGuardDecision("/products/p1", null)).toBe("allow");
    expect(getRouteGuardDecision("/invite", null)).toBe("allow"); // 品牌入驻落地页，非品牌后台
  });
});
