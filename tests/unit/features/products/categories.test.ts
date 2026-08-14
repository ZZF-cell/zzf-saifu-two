// products 模块单元测试 — 两级类目：常量树 + 组合校验 + getCategories 接口形状
// mock 系统边界：prisma（类目逻辑不查库，仅加载依赖需要）
// 只测公共 seam：PRODUCT_CATEGORIES 常量 / getSubcategories / isValidCategoryPair /
//   getCategories service / submitProductSchema / getCategories API handler

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/shared/db/client", () => ({ prisma: {} }));

import {
  PRODUCT_CATEGORIES,
  getSubcategories,
  isValidCategoryPair,
} from "@/shared/constants/product-categories";
import { getCategories as getCategoriesService } from "@/features/products/products.service";
import { getCategories as getCategoriesHandler } from "@/features/products/products.api";
import { submitProductSchema } from "@/features/brand/brand.api";

beforeEach(() => {
  vi.clearAllMocks();
});

// ── 类目常量树 ──

describe("PRODUCT_CATEGORIES — 预设两级类目树", () => {
  it("返回完整 5 个大类，顺序固定", () => {
    expect(PRODUCT_CATEGORIES.map((node) => node.category)).toEqual([
      "成人计生用品",
      "情趣用品",
      "智能设备",
      "身体护理",
      "其他",
    ]);
  });

  it("各大类子类清单与用户确认的初版清单一致", () => {
    expect(PRODUCT_CATEGORIES).toEqual([
      { category: "成人计生用品", subcategories: ["避孕套", "润滑液"] },
      {
        category: "情趣用品",
        subcategories: ["震动器具", "男用器具", "女用器具", "情趣内衣", "情趣玩具套装"],
      },
      { category: "智能设备", subcategories: ["智能健康监测", "智能情趣设备"] },
      { category: "身体护理", subcategories: ["身体乳/润体", "私密护理"] },
      { category: "其他", subcategories: ["其他"] },
    ]);
  });
});

// ── 服务层 getCategories ──

describe("getCategories（service）— 返回结构化两级树", () => {
  it("直接返回完整类目树（不再从在售商品反推）", async () => {
    await expect(getCategoriesService()).resolves.toEqual(PRODUCT_CATEGORIES);
  });
});

// ── 辅助函数 ──

describe("getSubcategories — 大类 → 子类列表", () => {
  it("已知大类返回其子类", () => {
    expect(getSubcategories("成人计生用品")).toEqual(["避孕套", "润滑液"]);
  });

  it("未知大类返回空数组", () => {
    expect(getSubcategories("不存在的类目")).toEqual([]);
  });
});

describe("isValidCategoryPair — 大类+子类组合校验", () => {
  it("合法组合 → true", () => {
    expect(isValidCategoryPair("成人计生用品", "避孕套")).toBe(true);
    expect(isValidCategoryPair("情趣用品", "震动器具")).toBe(true);
  });

  it("子类不属于该大类 → false", () => {
    expect(isValidCategoryPair("成人计生用品", "震动器具")).toBe(false);
  });

  it("未知大类 → false", () => {
    expect(isValidCategoryPair("不存在", "其他")).toBe(false);
  });

  it("子类为空 / null / undefined → false", () => {
    expect(isValidCategoryPair("成人计生用品", "")).toBe(false);
    expect(isValidCategoryPair("成人计生用品", null)).toBe(false);
    expect(isValidCategoryPair("成人计生用品", undefined)).toBe(false);
  });
});

// ── 提交商品校验（zod schema） ──

describe("submitProductSchema — 两级类目组合校验", () => {
  const base = {
    name: "测试商品",
    category: "成人计生用品",
    subCategory: "避孕套",
    price: 29.9,
    stock: 10,
  };

  it("合法组合 → pass", () => {
    expect(submitProductSchema.safeParse(base).success).toBe(true);
  });

  it("非法组合 → fail，错误路径指向 subCategory", () => {
    const result = submitProductSchema.safeParse({
      ...base,
      subCategory: "震动器具", // 震动器具属于情趣用品，不属于成人计生用品
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.subCategory).toBeDefined();
      expect(
        result.error.issues.find((issue) => issue.path[0] === "subCategory")?.message,
      ).toMatch(/合法组合/);
    }
  });

  it("缺 subCategory → fail（必填）", () => {
    const rest = {
      name: base.name,
      category: base.category,
      price: base.price,
      stock: base.stock,
    };
    expect(submitProductSchema.safeParse(rest).success).toBe(false);
  });
});

// ── API handler 形状 ──

describe("GET /api/products/categories（handler）— 返回 { categories: [...] }", () => {
  it("响应结构与常量类目树一致", async () => {
    const res = await getCategoriesHandler();
    const body = await res.json();
    expect(body.categories).toEqual(PRODUCT_CATEGORIES);
  });
});
