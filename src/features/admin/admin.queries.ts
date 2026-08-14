// 管理后台查询 — 数据看板 + 管理列表（只读）
import { prisma } from "@/shared/db/client";
import { ORDER_STATUS } from "@/features/orders";
import type { Prisma } from "@prisma/client";

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
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const paidFamily = [
    ORDER_STATUS.PAID,
    ORDER_STATUS.SHIPPED,
    ORDER_STATUS.DELIVERED,
    ORDER_STATUS.COMPLETED,
  ];

  const [
    userCount,
    brandCount,
    pendingBrandCount,
    productCount,
    pendingProductCount,
    orderCount,
    pendingRefundCount,
    revenueAgg,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.brand.count(),
    prisma.brand.count({ where: { status: "PENDING" } }),
    prisma.product.count(),
    prisma.product.count({ where: { status: "PENDING" } }),
    prisma.order.count(),
    prisma.order.count({ where: { status: ORDER_STATUS.REFUND_REQUESTED } }),
    prisma.order.aggregate({
      where: { status: { in: paidFamily } },
      _sum: { total: true },
    }),
  ]);

  return {
    userCount,
    brandCount,
    pendingBrandCount,
    productCount,
    pendingProductCount,
    orderCount,
    pendingRefundCount,
    paidRevenue: revenueAgg._sum.total ?? 0,
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

// ── 订单管理列表 ──

export interface AdminOrderRow {
  id: string;
  userId: string;
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
        _count: { select: { items: true } },
        items: { select: { productName: true }, take: 1, orderBy: { id: "asc" } },
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
      return {
        id: o.id,
        userId: o.userId,
        total: o.total,
        status: o.status,
        createdAt: o.createdAt,
        paidAt: o.paidAt,
        firstItemName: o.items[0]?.productName || "商品",
        itemCount: o._count.items, // 真实商品行数（_count 聚合）
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
  nickname: string | null;
  ageVerified: boolean;
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
        nickname: true,
        ageVerified: true,
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
