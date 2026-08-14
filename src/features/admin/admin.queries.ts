// 管理后台查询 — 数据看板 + 管理列表（只读）
import { prisma } from "@/shared/db/client";
import { ORDER_STATUS } from "@/features/orders";
import { decrypt } from "@/shared/utils/crypto";
import type { Prisma } from "@prisma/client";

/** 配送地址解密：ENCRYPTION_KEYS 未配置时明文；解密失败回退原文（兼容旧数据） */
function decryptAddress(shippingAddress: string): string {
  if (!process.env.ENCRYPTION_KEYS) return shippingAddress;
  try {
    return decrypt(shippingAddress);
  } catch {
    return shippingAddress;
  }
}

/** 手机号脱敏：13800138000 → 138****8000 */
function maskPhone(phone: string): string {
  if (phone.length < 7) return phone;
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

// ── 数据看板 ──

export interface DashboardStats {
  userCount: number;
  brandCount: number;
  pendingBrandCount: number;
  productCount: number;
  pendingProductCount: number;
  orderCount: number;
  pendingRefundCount: number;
  paidRevenue: number; // 已支付订单总金额（分）
  // ── 看板富化（Module D） ──
  toShipCount: number; // 待发货 = PAID + SHIPPED
  todayNewUsers: number; // 今日新增用户
  todayNewOrders: number; // 今日新增订单
  last7DaysRevenue: number[]; // 近 7 天每日销售额（分），下标 0 = 最早一天
  orderStatusDist: { status: string; count: number }[]; // 订单状态分布
  categoryDist: { category: string; count: number }[]; // 品类商品数分布
}

/** 已支付订单族（销售统计口径） */
const PAID_FAMILY = [
  ORDER_STATUS.PAID,
  ORDER_STATUS.SHIPPED,
  ORDER_STATUS.DELIVERED,
  ORDER_STATUS.COMPLETED,
];

export async function getDashboardStats(): Promise<DashboardStats> {
  // 今日零点（本地时区）
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  // 近 7 天起点（含今天，共 7 天）
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - 6);

  const [
    userCount,
    brandCount,
    pendingBrandCount,
    productCount,
    pendingProductCount,
    orderCount,
    pendingRefundCount,
    toShipCount,
    revenueAgg,
    todayNewUsers,
    todayNewOrders,
    statusGroups,
    categoryGroups,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.brand.count(),
    prisma.brand.count({ where: { status: "PENDING" } }),
    prisma.product.count(),
    prisma.product.count({ where: { status: "PENDING" } }),
    prisma.order.count(),
    prisma.order.count({ where: { status: ORDER_STATUS.REFUND_REQUESTED } }),
    prisma.order.count({
      where: { status: { in: [ORDER_STATUS.PAID, ORDER_STATUS.SHIPPED] } },
    }),
    prisma.order.aggregate({
      where: { status: { in: PAID_FAMILY } },
      _sum: { total: true },
    }),
    prisma.user.count({ where: { createdAt: { gte: todayStart } } }),
    prisma.order.count({ where: { createdAt: { gte: todayStart } } }),
    prisma.order.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.product.groupBy({ by: ["category"], _count: { _all: true } }),
  ]);

  // 近 7 天销售额：一次性拉取区间内已支付订单，在 JS 按天分桶（避免 7 次聚合查询）
  const weekOrders = await prisma.order.findMany({
    where: { status: { in: PAID_FAMILY }, paidAt: { gte: weekStart } },
    select: { paidAt: true, total: true },
  });
  const last7DaysRevenue = new Array<number>(7).fill(0);
  for (const o of weekOrders) {
    if (!o.paidAt) continue;
    const day = new Date(o.paidAt);
    day.setHours(0, 0, 0, 0);
    const idx = Math.round((day.getTime() - weekStart.getTime()) / 86400000);
    if (idx >= 0 && idx < 7) last7DaysRevenue[idx] += o.total;
  }

  return {
    userCount,
    brandCount,
    pendingBrandCount,
    productCount,
    pendingProductCount,
    orderCount,
    pendingRefundCount,
    paidRevenue: revenueAgg._sum.total ?? 0,
    toShipCount,
    todayNewUsers,
    todayNewOrders,
    last7DaysRevenue,
    orderStatusDist: statusGroups
      .map((g) => ({ status: g.status, count: g._count._all }))
      .sort((a, b) => b.count - a.count),
    categoryDist: categoryGroups
      .map((g) => ({ category: g.category, count: g._count._all }))
      .sort((a, b) => b.count - a.count),
  };
}

// ── 品牌审核列表 ──

export interface AdminBrandRow {
  id: string;
  name: string;
  logo: string | null;
  status: string;
  inviteCode: string;
  createdAt: Date;
  productCount: number;
  ownerNickname: string | null;
}

export async function getAdminBrands(status?: string): Promise<AdminBrandRow[]> {
  const brands = await prisma.brand.findMany({
    where: status ? { status } : undefined,
    select: {
      id: true,
      name: true,
      logo: true,
      status: true,
      inviteCode: true,
      createdAt: true,
      owner: { select: { nickname: true } },
      _count: { select: { products: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return brands.map((b) => ({
    id: b.id,
    name: b.name,
    logo: b.logo,
    status: b.status,
    inviteCode: b.inviteCode,
    createdAt: b.createdAt,
    productCount: b._count.products,
    ownerNickname: b.owner.nickname,
  }));
}

// ── 商品质检列表 ──

export interface AdminProductRow {
  id: string;
  name: string;
  category: string;
  subCategory: string | null;
  price: number;
  stock: number;
  status: string;
  sales: number;
  createdAt: Date;
  brandName: string;
}

export interface AdminProductListResult {
  items: AdminProductRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export async function getAdminProducts(params: {
  page: number;
  pageSize: number;
  status?: string;
}): Promise<AdminProductListResult> {
  const { page, pageSize, status } = params;
  const where: Prisma.ProductWhereInput = status ? { status } : {};

  const [items, total] = await Promise.all([
    prisma.product.findMany({
      where,
      select: {
        id: true,
        name: true,
        category: true,
        subCategory: true,
        price: true,
        stock: true,
        status: true,
        sales: true,
        createdAt: true,
        brand: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.product.count({ where }),
  ]);

  return {
    items: items.map((p) => ({ ...p, brandName: p.brand.name })),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

// ── 商品详情（管理端：完整信息 + 该品类质检清单） ──

export interface AdminProductDetail {
  id: string;
  name: string;
  description: string | null;
  category: string;
  subCategory: string | null;
  price: number;
  stock: number;
  status: string;
  sales: number;
  images: unknown;
  certificates: unknown;
  specs: unknown;
  createdAt: Date;
  updatedAt: Date;
  version: number;
  brand: { id: string; name: string; logo: string | null } | null;
  /** 该大类质检模板（requiredDocs/checkPoints）；无模板 → null */
  qcTemplate: {
    requiredDocs: unknown;
    checkPoints: unknown;
  } | null;
}

/**
 * 管理端商品详情 — 商品全字段 + 品牌 + 该品类质检清单。
 * 质检清单决定审核员「按什么标准查什么」，是审核决策的完整信息闭环。
 */
export async function getAdminProductDetail(productId: string): Promise<AdminProductDetail | null> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: {
      brand: { select: { id: true, name: true, logo: true } },
    },
  });
  if (!product) return null;

  const template = await prisma.categoryAuditTemplate.findUnique({
    where: { categoryId: product.category },
    select: { requiredDocs: true, checkPoints: true },
  });

  return {
    id: product.id,
    name: product.name,
    description: product.description,
    category: product.category,
    subCategory: product.subCategory,
    price: product.price,
    stock: product.stock,
    status: product.status,
    sales: product.sales,
    images: product.images,
    certificates: product.certificates,
    specs: product.specs,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
    version: product.version,
    brand: product.brand,
    qcTemplate: template,
  };
}

// ── 订单管理列表 ──

export interface AdminOrderRow {
  id: string;
  userId: string;
  buyerNickname: string | null;
  /** 收货人信息（姓名 + 脱敏手机号 + 城市），配送地址解密而来 */
  recipient: { name: string; phone: string; city: string } | null;
  total: number;
  status: string;
  createdAt: Date;
  paidAt: Date | null;
  firstItemName: string;
  itemCount: number;
  isDestroyed: boolean;
}

export interface AdminOrderListResult {
  orders: AdminOrderRow[];
  total: number;
  page: number;
  pageSize: number;
}

export async function getAdminOrders(params: {
  page: number;
  pageSize: number;
  status?: string;
}): Promise<AdminOrderListResult> {
  const { page, pageSize, status } = params;
  const where: Prisma.OrderWhereInput = status ? { status } : {};

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      select: {
        id: true,
        userId: true,
        total: true,
        status: true,
        createdAt: true,
        paidAt: true,
        privacy: true,
        shippingAddress: true,
        user: { select: { nickname: true } },
        items: { select: { productName: true, qty: true }, orderBy: { id: "asc" } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.order.count({ where }),
  ]);

  return {
    orders: orders.map((o) => {
      const privacy = o.privacy as { destroyed?: boolean } | null;
      // 收货人信息：地址解密后取姓名/手机号/城市（手机号脱敏展示）
      let recipient: AdminOrderRow["recipient"] = null;
      try {
        const addr = JSON.parse(decryptAddress(o.shippingAddress)) as {
          name?: string;
          phone?: string;
          city?: string;
        };
        if (addr && (addr.name || addr.phone || addr.city)) {
          recipient = {
            name: addr.name || "—",
            phone: addr.phone ? maskPhone(addr.phone) : "—",
            city: addr.city || "",
          };
        }
      } catch {
        recipient = null; // 地址解析失败不阻断列表
      }
      return {
        id: o.id,
        userId: o.userId,
        buyerNickname: o.user.nickname,
        recipient,
        total: o.total,
        status: o.status,
        createdAt: o.createdAt,
        paidAt: o.paidAt,
        firstItemName: o.items[0]?.productName || "商品",
        // 件数 = 各明细数量之和（qty 累加，非明细行数）
        itemCount: o.items.reduce((sum, i) => sum + i.qty, 0),
        isDestroyed: !!(privacy && privacy.destroyed),
      };
    }),
    total,
    page,
    pageSize,
  };
}

// ── 用户管理列表 ──

export interface AdminUserRow {
  id: string;
  role: string;
  status: string; // ACTIVE | DISABLED
  nickname: string | null;
  ageVerified: boolean;
  /** 密码登录锁定截止（null = 未锁定）；判断是否可「解锁」 */
  lockUntil: Date | null;
  createdAt: Date;
  orderCount: number;
}

export interface AdminUserListResult {
  items: AdminUserRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export async function getAdminUsers(params: {
  page: number;
  pageSize: number;
}): Promise<AdminUserListResult> {
  const { page, pageSize } = params;

  const [items, total] = await Promise.all([
    prisma.user.findMany({
      select: {
        id: true,
        role: true,
        status: true,
        nickname: true,
        ageVerified: true,
        lockUntil: true,
        createdAt: true,
        _count: { select: { orders: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.user.count(),
  ]);

  return {
    items: items.map((u) => ({ ...u, orderCount: u._count.orders })),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

// ── 质检模板 ──

export interface AuditTemplate {
  categoryId: string;
  requiredDocs: unknown;
  checkPoints: unknown;
}

export async function getAuditTemplates(): Promise<AuditTemplate[]> {
  return prisma.categoryAuditTemplate.findMany({
    orderBy: { categoryId: "asc" },
  });
}

// ── 邀请码管理列表 ──

export interface AdminInviteCodeRow {
  id: string;
  code: string;
  status: string; // UNUSED | USED | EXPIRED（EXPIRED 为推导态，不落库）
  createdBy: string;
  usedBy: string | null;
  createdAt: Date;
  usedAt: Date | null;
  expiresAt: Date | null;
}

export interface AdminInviteCodeListResult {
  items: AdminInviteCodeRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** 推导行状态：USED > EXPIRED > UNUSED（EXPIRED 由 expiresAt 即时推导） */
function deriveInviteStatus(status: string, expiresAt: Date | null, now: Date): string {
  if (status === "USED") return "USED";
  if (expiresAt && expiresAt.getTime() < now.getTime()) return "EXPIRED";
  return "UNUSED";
}

export async function getAdminInviteCodes(params: {
  page: number;
  pageSize: number;
  status?: string;
}): Promise<AdminInviteCodeListResult> {
  const { page, pageSize, status } = params;
  const now = new Date();

  // EXPIRED 是推导态：筛选时按「UNUSED 且 expiresAt < now」等价展开
  const where: Prisma.InviteCodeWhereInput = {};
  if (status === "USED") {
    where.status = "USED";
  } else if (status === "EXPIRED") {
    where.status = "UNUSED";
    where.expiresAt = { lt: now };
  } else if (status === "UNUSED") {
    where.status = "UNUSED";
    where.OR = [{ expiresAt: null }, { expiresAt: { gte: now } }];
  }

  const [items, total] = await Promise.all([
    prisma.inviteCode.findMany({
      where,
      select: {
        id: true,
        code: true,
        status: true,
        createdBy: true,
        usedBy: true,
        createdAt: true,
        usedAt: true,
        expiresAt: true,
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.inviteCode.count({ where }),
  ]);

  return {
    items: items.map((i) => ({
      ...i,
      status: deriveInviteStatus(i.status, i.expiresAt, now),
    })),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}
