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
import { hashPhone, hashPassword } from "../src/shared/utils/crypto";

const prisma = new PrismaClient();

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
      description: "智能生理期管理手环（示例商品，沙箱支付测试用）",
      price: 19900, // 199.00 元（分）
      stock: 100,
    },
    {
      name: "山茶润体油",
      category: "身体护理",
      description: "温和植物润体油（示例商品，沙箱支付测试用）",
      price: 8900, // 89.00 元（分）
      stock: 200,
    },
  ];

  for (const p of products) {
    await prisma.product.upsert({
      where: { id: `seed-${p.name}` },
      update: { status: "APPROVED" },
      create: {
        id: `seed-${p.name}`,
        brandId: brand.id,
        name: p.name,
        description: p.description,
        category: p.category,
        price: p.price,
        stock: p.stock,
        status: "APPROVED",
      },
    });
  }

  console.log("✅ seed 完成");
  console.log(`  管理员: 13900000000 (验证码登录)  id=${admin.id}`);
  console.log(`  用户:   13800138000 / 123456      id=${buyer.id}`);
  console.log(`  品牌方: 13888888888 (验证码登录)  id=${brandOwner.id}`);
  console.log(`  品牌:   ${brand.name}（${brand.inviteCode}）`);
  console.log(`  入驻邀请码: ${seedInviteCodes.map((c) => c.code).join("、")}`);
  console.log(`  商品:   ${products.map((p) => p.name).join("、")}`);
}

main()
  .catch((e) => {
    console.error("❌ seed 失败:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
