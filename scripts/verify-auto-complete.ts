// 造数据验证「送达 7 天自动确认收货」核心逻辑（order-delivery-complete-sweep 的 service seam）
// 用法: npx tsx scripts/verify-auto-complete.ts   （需本地库已 seed：三角色账号 + 8 笔全状态订单）
//
// 场景1（service seam）: 一笔订单置 DELIVERED + deliveredAt=8 天前 → autoCompleteDeliveredOrder
//                     应返回 completed:true，状态 COMPLETED + completedAt 非空，
//                     审计 AUTO_COMPLETED（operatorId=null，snapshot before=DELIVERED after=COMPLETED）
// 场景2（sweep 查询口径）: 「7 天窗口」过滤在 sweep 的 findMany（deliveredAt < cutoff），
//                     autoCompleteDeliveredOrder 只做 status=DELIVERED 状态守卫、不判时间。
//                     造一笔 deliveredAt=昨天的 DELIVERED → 不应被 sweep 查询选中（未过窗口）。
//
// cron 本身由 Inngest Cloud 调度（本地可用 inngest:dev 测），此脚本直接测 cron 调用的 service seam，
// 与仓库「只测 service seam、不测 Inngest 包装层」策略一致。

import { PrismaClient } from "@prisma/client";
import {
  autoCompleteDeliveredOrder,
  AUTO_CONFIRM_RECEIPT_MS,
  ORDER_STATUS,
} from "@/features/orders";

const prisma = new PrismaClient();
const DAY = 24 * 60 * 60 * 1000;

function assert(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(`断言失败: ${label}`);
}

async function setDelivered(orderId: string, deliveredAt: Date) {
  const r = await prisma.order.updateMany({
    where: { id: orderId },
    data: { status: ORDER_STATUS.DELIVERED, deliveredAt },
  });
  if (r.count !== 1) throw new Error(`订单 ${orderId} 置 DELIVERED 失败`);
}

async function run() {
  // 造数据：任取一笔种子订单置 DELIVERED（autoComplete 只看 status=DELIVERED + 时间，与历史状态无关，
  // 因此可重复运行，不依赖特定状态订单）
  const o1 = await prisma.order.findFirst({ orderBy: { createdAt: "asc" } });
  assert(o1, "找不到种子订单（请先 npx prisma db seed）");

  console.log(`\n场景1: ${o1!.id} 置 DELIVERED + deliveredAt=8天前`);
  await setDelivered(o1!.id, new Date(Date.now() - 8 * DAY));
  const r1 = await autoCompleteDeliveredOrder(o1!.id);
  const d1 = await prisma.order.findUnique({ where: { id: o1!.id } });
  const a1 = await prisma.auditLog.findFirst({
    where: { targetType: "Order", targetId: o1!.id, action: "AUTO_COMPLETED" },
    orderBy: { createdAt: "desc" },
  });
  console.log(`  → completed: ${r1.completed} | status: ${d1?.status} | completedAt: ${d1?.completedAt}`);
  console.log(`  → audit operatorId: ${a1?.operatorId} | snapshot: ${JSON.stringify(a1?.snapshot)}`);
  assert(r1.completed === true, "场景1: completed 应为 true");
  assert(d1?.status === ORDER_STATUS.COMPLETED, "场景1: 状态应为 COMPLETED");
  assert(d1?.completedAt, "场景1: completedAt 应非空");
  assert(a1 && a1.operatorId === null, "场景1: 审计 operatorId 应为 null（系统动作）");
  assert(
    a1 &&
      (a1.snapshot as { before?: string }).before === ORDER_STATUS.DELIVERED &&
      (a1.snapshot as { after?: string }).after === ORDER_STATUS.COMPLETED,
    "场景1: 审计 snapshot before/after 不符",
  );

  // 场景2：验证「7 天窗口」过滤在 sweep 查询层（autoCompleteDeliveredOrder 只做状态守卫、不判时间）
  // 造一笔 deliveredAt=昨天的 DELIVERED → sweep 的 findMany 查询不应选中它（未过窗口）
  const o2 = await prisma.order.findFirst({
    where: { NOT: { id: o1!.id } },
    orderBy: { createdAt: "asc" },
  });
  assert(o2, "找不到第二笔种子订单");
  console.log(`\n场景2: ${o2!.id} 置 DELIVERED + deliveredAt=昨天（sweep 查询口径）`);
  await setDelivered(o2!.id, new Date(Date.now() - 1 * DAY));
  const cutoff = new Date(Date.now() - AUTO_CONFIRM_RECEIPT_MS);
  const overdue = await prisma.order.findMany({
    where: { status: ORDER_STATUS.DELIVERED, deliveredAt: { lt: cutoff } },
    select: { id: true },
  });
  const hit = overdue.some((o) => o.id === o2!.id);
  console.log(`  → 昨日订单被 sweep 选中? ${hit} | 当前过期集合: ${overdue.map((o) => o.id).join(", ") || "空"}`);
  assert(!hit, "场景2: 未过 7 天窗口的订单不应被 sweep 选中");

  console.log("\n✅ 自动确认造数据验证通过（场景1=service 状态守卫 + 审计；场景2=sweep 7 天窗口过滤）");
}

run()
  .catch((e) => {
    console.error("❌", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
