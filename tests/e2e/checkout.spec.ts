// E2E: 订单核心闭环（下单 → 退款 → 销毁）
// 依赖 global-setup 重置数据库 + seed：三角色账号、全状态种子订单。
//   - 退款链路消费 seed-order-paid（PAID）
//   - 销毁链路消费 seed-order-delivered（DELIVERED，山茶润体油×3 = ¥267.00）
// 每文件串行（fullyParallel: false）：多角色通过 browser.newContext() 开独立会话，互不污染登录态。
import { test, expect, type Page } from "@playwright/test";

// ---------- 登录工具 ----------

/** 密码登录：点「密码登录」Tab → 填手机号/密码 → 提交 → 回首页 */
async function passwordLogin(page: Page, phone: string, password: string) {
  await page.goto("/login");
  await page.getByRole("button", { name: "密码登录" }).first().click();
  await page.getByPlaceholder("请输入手机号").fill(phone);
  await page.getByPlaceholder("请输入密码").fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((u) => u.pathname === "/");
}

/** 验证码登录：点「验证码登录」Tab → 填手机号 → 获取验证码 → 从演示模式回显提取 6 位 → 提交 */
async function codeLogin(page: Page, phone: string) {
  await page.goto("/login");
  await page.getByRole("button", { name: "验证码登录" }).first().click();
  await page.getByPlaceholder("请输入手机号").fill(phone);
  await page.getByRole("button", { name: "获取验证码" }).click();
  // 演示模式：验证码明文回显在页面（短信未配置时）
  const demoText = await page.locator("text=演示模式验证码").first().textContent();
  const code = demoText?.match(/\d{6}/)?.[0];
  expect(code, "应能读取演示模式验证码").toBeTruthy();
  await page.getByPlaceholder("请输入 6 位验证码").fill(code!);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((u) => u.pathname === "/");
}

// ---------- 测试 ----------

test.describe("完整下单链路", () => {
  test("浏览商品 → 加购 → 结算 → 创建订单（进入可支付状态）", async ({ page }) => {
    await passwordLogin(page, "13800138000", "123456");

    // 首页进入商品详情
    await page.goto("/");
    await page.getByRole("link", { name: "悦己手环 Pro" }).first().click();
    await page.waitForURL(/\/products\/\w+/);

    // 加入购物车 → 购物车页（加购成功会 router.push("/cart")，再显式 goto 兜底）
    await page.getByRole("button", { name: "加入购物车" }).click();
    await page.goto("/cart");
    // 结算条渲染出来（购物车数据加载完成）；部分结算默认未勾选 → 先全选，去结算才可用
    await expect(page.getByRole("button", { name: /去结算/ })).toBeVisible();
    await page.getByRole("checkbox", { name: "全选" }).check();
    const checkoutBtn = page.getByRole("button", { name: /去结算/ });
    await expect(checkoutBtn).toBeEnabled();
    await checkoutBtn.click();
    await page.waitForURL(/\/checkout/);

    // 填收货地址（必填字段）
    await page.getByPlaceholder("收货人姓名").fill("E2E 测试");
    await page.getByPlaceholder("手机号").fill("13800138000");
    await page.getByPlaceholder("省份").fill("广东省");
    await page.getByPlaceholder("城市").fill("深圳市");
    await page.getByPlaceholder("区/县").fill("南山区");
    await page.getByPlaceholder("详细地址").fill("科技园路 1 号");
    await page.getByRole("button", { name: "提交订单" }).click();

    // 订单创建成功：未配支付渠道 → 显式提示订单已创建；已配 → 弹出扫码支付
    await expect(page.getByText(/订单已创建|扫码支付/).first()).toBeVisible({ timeout: 20000 });
  });
});

test.describe("退款链路", () => {
  test("用户申请退款 → 管理员确认 → 双方看到已退款", async ({ browser, page }) => {
    await passwordLogin(page, "13800138000", "123456");

    // 用户侧：PAID 订单申请退款
    await page.goto("/orders/seed-order-paid");
    await expect(page.getByText("已支付")).toBeVisible();
    await page.getByRole("button", { name: "申请退款" }).click();
    await expect(page.getByText("退款中")).toBeVisible();

    // 管理后台：确认退款（确认后卡片重新渲染，用新定位断言）
    const adminCtx = await browser.newContext();
    try {
      const admin = await adminCtx.newPage();
      await codeLogin(admin, "13900000000");
      await admin.goto("/admin");
      await admin.getByRole("button", { name: "订单管理" }).click();
      const paidCard = admin.locator("div.rounded-2xl", { hasText: "seed-order-paid" }).first();
      await paidCard.getByRole("button", { name: "确认退款" }).click();
      await expect(
        admin.locator("div.rounded-2xl", { hasText: "seed-order-paid" }).getByText("已退款"),
      ).toBeVisible();
    } finally {
      await adminCtx.close();
    }

    // 用户侧同步为已退款
    await page.goto("/orders/seed-order-paid");
    await expect(page.getByText("已退款")).toBeVisible();
  });
});

test.describe("订单销毁", () => {
  test("确认收货 → 一键销毁 → 用户/品牌侧消失、管理后台保留", async ({ browser, page }) => {
    // 品牌方先登录，记录销毁前「山茶润体油」订单卡片数
    const brandCtx = await browser.newContext();
    const adminCtx = await browser.newContext();
    try {
      const brand = await brandCtx.newPage();
      await codeLogin(brand, "13888888888");
      await brand.goto("/brand");
      await brand.getByRole("button", { name: "品牌订单" }).click();
      // 等列表异步加载完成，再数卡片（否则首帧为空计数 0）
      await expect(brand.getByText("山茶润体油").first()).toBeVisible();
      const oilCards = () => brand.locator("div.rounded-xl", { hasText: "山茶润体油" }).count();
      const before = await oilCards();
      expect(before).toBeGreaterThan(0);

      // 用户侧：DELIVERED → 确认收货 → 已完成 → 一键销毁 → 回订单列表
      await passwordLogin(page, "13800138000", "123456");
      await page.goto("/orders/seed-order-delivered");
      await expect(page.getByText("已送达")).toBeVisible();
      await page.getByRole("button", { name: "确认收货" }).click();
      await expect(page.getByText("已完成")).toBeVisible();
      await page.getByRole("button", { name: "一键销毁" }).click();
      await page.waitForURL(/\/orders$/);

      // 用户列表消失：seed-order-delivered 是唯一 ¥267.00 订单
      await expect(page.getByText("¥267.00")).not.toBeVisible();
      // 详情已不可见（对用户 404/已销毁）
      await page.goto("/orders/seed-order-delivered");
      await expect(page.getByText(/订单不存在|已销毁/)).toBeVisible();

      // 品牌侧刷新品牌订单 → 卡片减 1
      await brand.getByRole("button", { name: "品牌概览" }).click();
      await brand.getByRole("button", { name: "品牌订单" }).click();
      await expect.poll(oilCards).toBe(before - 1);
    } finally {
      await brandCtx.close();
    }

    // 管理后台：订单保留且标记已销毁（仅管理可见）
    try {
      const admin = await adminCtx.newPage();
      await codeLogin(admin, "13900000000");
      await admin.goto("/admin");
      await admin.getByRole("button", { name: "订单管理" }).click();
      const deliveredCard = admin
        .locator("div.rounded-2xl", { hasText: "seed-order-delivered" })
        .first();
      await expect(deliveredCard).toBeVisible();
      await expect(deliveredCard.getByText("已销毁")).toBeVisible();
    } finally {
      await adminCtx.close();
    }
  });
});

// ---------- 购物车部分结算回归（bug: 下单一个后剩余商品被误删） ----------
// 回归点：修复前结算页在 /checkout 无 ?items=（直接访问/书签/登录跳转丢 query）时
// 「静默回退全量」，把整张购物车 POST 下单 → createOrder Step 4 删光全部行。
// 修复：前端去回退全量（空态引导），服务端校验 items ⊆ 购物车。
// 两个测试按顺序共享购物车（场景2 复用场景1 剩余的「山茶润体油」），同文件串行安全。

test.describe("购物车部分结算", () => {
  test("勾选一个商品去结算下单，剩余商品应保留", async ({ page }) => {
    await passwordLogin(page, "13800138000", "123456");

    // API 加购两个商品（复用登录 cookie）
    await page.request.post("/api/cart", { data: { productId: "seed-悦己手环 Pro", qty: 1 } });
    await page.request.post("/api/cart", { data: { productId: "seed-山茶润体油", qty: 1 } });

    // 购物车应显示 2 个商品
    await page.goto("/cart");
    await expect(page.getByText("悦己手环 Pro").first()).toBeVisible();
    await expect(page.getByText("山茶润体油").first()).toBeVisible();

    // 只勾选「悦己手环 Pro」去结算（部分结算，只带 1 个）
    await page.getByRole("checkbox", { name: "选择 悦己手环 Pro" }).check();
    await page.getByRole("button", { name: /去结算/ }).click();
    await page.waitForURL(/\/checkout/);

    // 结算页应只显示勾选的悦己手环 Pro
    await expect(page.getByText("悦己手环 Pro").first()).toBeVisible();
    await expect(page.getByText("山茶润体油")).not.toBeVisible();

    // 填地址提交下单
    await page.getByPlaceholder("收货人姓名").fill("复现测试");
    await page.getByPlaceholder("手机号").fill("13800138000");
    await page.getByPlaceholder("省份").fill("广东省");
    await page.getByPlaceholder("城市").fill("深圳市");
    await page.getByPlaceholder("区/县").fill("南山区");
    await page.getByPlaceholder("详细地址").fill("科技园路 1 号");
    await page.getByRole("button", { name: "提交订单" }).click();
    await expect(page.getByText(/订单已创建|扫码支付/).first()).toBeVisible({ timeout: 20000 });

    // 返回购物车：山茶润体油应保留、悦己手环 Pro 已下单消失
    await page.goto("/cart");
    await expect(page.getByText("山茶润体油").first()).toBeVisible();
    await expect(page.getByText("悦己手环 Pro")).not.toBeVisible();
  });

  test("直接访问 /checkout（无 ?items=）显示空态引导，购物车商品不被误删", async ({ page }) => {
    await passwordLogin(page, "13800138000", "123456");

    // 此时购物车已有场景1 剩余的「山茶润体油」；再加购一个「悦己手环 Pro」
    await page.request.post("/api/cart", { data: { productId: "seed-悦己手环 Pro", qty: 1 } });

    // 不经过购物车勾选，直接访问 /checkout（模拟手输/书签/登录跳转丢 query）
    await page.goto("/checkout");
    // 修复后：无 ?items= 显示空态引导，不展示商品、不静默全量结算
    await expect(page.getByText("未选择结算商品，请先到购物车勾选").first()).toBeVisible();
    await expect(page.getByText("悦己手环 Pro")).not.toBeVisible();
    await expect(page.getByText("山茶润体油")).not.toBeVisible();
    await expect(page.getByRole("button", { name: "提交订单" })).not.toBeVisible();

    // 点「去购物车」返回后，两个商品都应保留（未发生误删）
    await page.getByRole("button", { name: "去购物车" }).click();
    await page.waitForURL(/\/cart/);
    await expect(page.getByText("悦己手环 Pro").first()).toBeVisible();
    await expect(page.getByText("山茶润体油").first()).toBeVisible();
  });
});
