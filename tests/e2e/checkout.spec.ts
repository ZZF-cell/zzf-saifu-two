// E2E: 核心购买闭环
// 注册 → 浏览 → 加购 → 下单 → 支付回调 → 退款
import { test, expect } from "@playwright/test";

test.describe("完整下单链路", () => {
  test("用户可以从首页浏览商品并加入购物车", async ({ page }) => {
    // TODO: 实现后替换
    await page.goto("/");
    expect(await page.title()).toContain("赛夫严选");
  });

  test("用户可以从购物车结算并创建订单", async () => {
    // TODO: 覆盖乐观锁库存扣减、支付单创建
  });
});

test.describe("退款链路", () => {
  test("用户可以申请退款 → 管理员确认 → 状态变为 REFUNDED", async () => {
    // TODO: 覆盖状态机流转、退款幂等
  });
});

test.describe("订单销毁", () => {
  test("订单完成后可一键销毁 → 隐私数据擦除", async () => {
    // TODO: 覆盖 AES 加密、隐私数据擦除
  });
});
