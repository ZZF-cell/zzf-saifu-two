// 种子数据 — 三角色测试账号 + 示例品牌/商品
// 运行: npx prisma db seed（package.json: "prisma.seed": "tsx prisma/seed.ts"）
// 幂等: 全部使用 upsert（按 phoneHash / inviteCode 键），可重复执行
//
// 测试账号（README）:
//   管理员   13900000000  （验证码登录）
//   普通用户 13800138000  密码 123456
//   品牌方   13888888888  （验证码登录，拥有品牌 "悦己实验室"）
// 示例商品: 悦己手环 Pro / 山茶润体油（status=APPROVED，可用于下单支付闭环）

import { PrismaClient } from "@prisma/client";
import { hashPhone, hashPassword, encrypt } from "../src/shared/utils/crypto";

const prisma = new PrismaClient();

/** 配送地址序列化：与 orders.service.serializeAddress 一致（ENCRYPTION_KEYS 未配置时明文，仅限开发） */
function serializeSeedAddress(addr: unknown): string {
  const json = JSON.stringify(addr);
  return process.env.ENCRYPTION_KEYS ? encrypt(json) : json;
}

/** 相对天数生成时间戳（演示订单错落的时间线） */
function ts(daysAgo: number, hoursAgo = 0): Date {
  return new Date(Date.now() - daysAgo * 86400000 - hoursAgo * 3600000);
}

async function main() {
  // ── 三角色用户 ──
  const admin = await prisma.user.upsert({
    where: { phoneHash: hashPhone("13900000000") },
    update: { role: "ADMIN" },
    create: { phoneHash: hashPhone("13900000000"), role: "ADMIN" },
  });

  const buyer = await prisma.user.upsert({
    where: { phoneHash: hashPhone("13800138000") },
    update: { passwordHash: await hashPassword("123456") },
    create: {
      phoneHash: hashPhone("13800138000"),
      passwordHash: await hashPassword("123456"),
      role: "USER",
    },
  });

  const brandOwner = await prisma.user.upsert({
    where: { phoneHash: hashPhone("13888888888") },
    update: { role: "BRAND" },
    create: { phoneHash: hashPhone("13888888888"), role: "BRAND" },
  });

  // ── 品牌 ──
  const brand = await prisma.brand.upsert({
    where: { inviteCode: "SEED-BRAND-001" },
    update: { status: "APPROVED" },
    create: {
      name: "悦己实验室",
      inviteCode: "SEED-BRAND-001",
      status: "APPROVED",
      ownerId: brandOwner.id,
    },
  });

  // ── 预生成入驻邀请码（可重复执行；update:{} 只补缺，绝不复活已使用/已过期码） ──
  const seedInviteCodes = [
    { code: "INVITE-BRAND-101", expiresAt: null as Date | null },
    { code: "INVITE-BRAND-102", expiresAt: null as Date | null },
  ];
  for (const ic of seedInviteCodes) {
    await prisma.inviteCode.upsert({
      where: { code: ic.code },
      update: {}, // 幂等：创建即停，不回滚消耗状态
      create: { code: ic.code, createdBy: admin.id, expiresAt: ic.expiresAt },
    });
  }

  // ── 示例商品（APPROVED 且库存充足，用于支付闭环） ──
  const products = [
    {
      name: "悦己手环 Pro",
      category: "智能设备",
      subCategory: "智能健康监测",
      description: "智能生理期管理手环（示例商品，沙箱支付测试用）",
      price: 19900, // 199.00 元（分）
      stock: 100,
    },
    {
      name: "山茶润体油",
      category: "身体护理",
      subCategory: "身体乳/润体",
      description: "温和植物润体油（示例商品，沙箱支付测试用）",
      price: 8900, // 89.00 元（分）
      stock: 200,
    },
  ];

  for (const p of products) {
    await prisma.product.upsert({
      where: { id: `seed-${p.name}` },
      // update 分支同步补 subCategory：已存在（旧数据）的 seed 商品也能幂等补齐两级类目
      update: { status: "APPROVED", subCategory: p.subCategory },
      create: {
        id: `seed-${p.name}`,
        brandId: brand.id,
        name: p.name,
        description: p.description,
        category: p.category,
        subCategory: p.subCategory,
        price: p.price,
        stock: p.stock,
        status: "APPROVED",
      },
    });
  }

  // ── 演示订单（覆盖全部状态，管理后台订单筛选可逐态查看；幂等可重跑） ──
  const hand = { name: "悦己手环 Pro", id: "seed-悦己手环 Pro", price: 19900 };
  const oil = { name: "山茶润体油", id: "seed-山茶润体油", price: 8900 };
  const address = {
    name: "张测试",
    phone: "13800138000",
    province: "广东省",
    city: "深圳市",
    district: "南山区",
    detail: "科技园路 1 号",
    zipCode: "518000",
  };
  const shippingAddress = serializeSeedAddress(address);

  const seedOrders: {
    id: string;
    status: string;
    createdAt: Date;
    paidAt: Date | null;
    shippedAt: Date | null;
    deliveredAt: Date | null;
    completedAt: Date | null;
    cancelledAt: Date | null;
    refundedAt: Date | null;
    outTradeNo: string | null;
    items: { productId: string; productName: string; price: number; qty: number }[];
  }[] = [
    {
      id: "seed-order-pending", status: "PENDING",
      createdAt: ts(0, 1), paidAt: null, shippedAt: null, deliveredAt: null,
      completedAt: null, cancelledAt: null, refundedAt: null, outTradeNo: null,
      items: [{ productId: hand.id, productName: hand.name, price: hand.price, qty: 1 }],
    },
    {
      id: "seed-order-paid", status: "PAID",
      createdAt: ts(1), paidAt: ts(1, 2), shippedAt: null, deliveredAt: null,
      completedAt: null, cancelledAt: null, refundedAt: null, outTradeNo: "seed-pay-001",
      items: [
        { productId: oil.id, productName: oil.name, price: oil.price, qty: 2 },
      ],
    },
    {
      id: "seed-order-shipped", status: "SHIPPED",
      createdAt: ts(2), paidAt: ts(2, 1), shippedAt: ts(1, 6), deliveredAt: null,
      completedAt: null, cancelledAt: null, refundedAt: null, outTradeNo: "seed-pay-002",
      items: [{ productId: hand.id, productName: hand.name, price: hand.price, qty: 1 }],
    },
    {
      id: "seed-order-delivered", status: "DELIVERED",
      createdAt: ts(3), paidAt: ts(3, 1), shippedAt: ts(2, 10), deliveredAt: ts(1, 5),
      completedAt: null, cancelledAt: null, refundedAt: null, outTradeNo: "seed-pay-003",
      items: [{ productId: oil.id, productName: oil.name, price: oil.price, qty: 3 }],
    },
    {
      id: "seed-order-completed", status: "COMPLETED",
      createdAt: ts(5), paidAt: ts(5, 1), shippedAt: ts(4, 10), deliveredAt: ts(4, 2),
      completedAt: ts(3, 6), cancelledAt: null, refundedAt: null, outTradeNo: "seed-pay-004",
      items: [{ productId: hand.id, productName: hand.name, price: hand.price, qty: 1 }],
    },
    {
      id: "seed-order-refund-requested", status: "REFUND_REQUESTED",
      createdAt: ts(4), paidAt: ts(4, 1), shippedAt: null, deliveredAt: null,
      completedAt: null, cancelledAt: null, refundedAt: null, outTradeNo: "seed-pay-005",
      items: [{ productId: oil.id, productName: oil.name, price: oil.price, qty: 1 }],
    },
    {
      id: "seed-order-refunded", status: "REFUNDED",
      createdAt: ts(6), paidAt: ts(6, 1), shippedAt: null, deliveredAt: null,
      completedAt: null, cancelledAt: null, refundedAt: ts(5, 4), outTradeNo: "seed-pay-006",
      items: [{ productId: hand.id, productName: hand.name, price: hand.price, qty: 2 }],
    },
    {
      id: "seed-order-cancelled", status: "CANCELLED",
      createdAt: ts(7), paidAt: null, shippedAt: null, deliveredAt: null,
      completedAt: null, cancelledAt: ts(7, 2), refundedAt: null, outTradeNo: null,
      items: [{ productId: oil.id, productName: oil.name, price: oil.price, qty: 1 }],
    },
  ];

  for (const o of seedOrders) {
    const total = o.items.reduce((sum, i) => sum + i.price * i.qty, 0);
    await prisma.order.upsert({
      where: { id: o.id },
      // update 同步状态与时间线，保证重跑后状态与 README 一致
      update: {
        status: o.status,
        total,
        paidAt: o.paidAt,
        shippedAt: o.shippedAt,
        deliveredAt: o.deliveredAt,
        completedAt: o.completedAt,
        cancelledAt: o.cancelledAt,
        refundedAt: o.refundedAt,
      },
      create: {
        id: o.id,
        userId: buyer.id,
        total,
        status: o.status,
        privacy: { anonymousPackaging: true, hideProductName: true },
        shippingAddress,
        outTradeNo: o.outTradeNo,
        paidAt: o.paidAt,
        shippedAt: o.shippedAt,
        deliveredAt: o.deliveredAt,
        completedAt: o.completedAt,
        cancelledAt: o.cancelledAt,
        refundedAt: o.refundedAt,
        createdAt: o.createdAt,
      },
    });
    // 幂等：明细先清后建，避免重跑时嵌套 create 重复累积
    await prisma.orderItem.deleteMany({ where: { orderId: o.id } });
    await prisma.orderItem.createMany({
      data: o.items.map((i) => ({
        orderId: o.id,
        productId: i.productId,
        productName: i.productName,
        price: i.price,
        qty: i.qty,
      })),
    });
  }

  console.log("✅ seed 完成");
  console.log(`  管理员: 13900000000 (验证码登录)  id=${admin.id}`);
  console.log(`  用户:   13800138000 / 123456      id=${buyer.id}`);
  console.log(`  品牌方: 13888888888 (验证码登录)  id=${brandOwner.id}`);
  console.log(`  品牌:   ${brand.name}（${brand.inviteCode}）`);
  console.log(`  入驻邀请码: ${seedInviteCodes.map((c) => c.code).join("、")}`);
  console.log(`  商品:   ${products.map((p) => p.name).join("、")}`);
  console.log(`  演示订单: ${seedOrders.length} 笔（覆盖 PENDING→COMPLETED 全状态）`);
}

main()
  .catch((e) => {
    console.error("❌ seed 失败:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
