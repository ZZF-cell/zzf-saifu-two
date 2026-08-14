// 商品两级类目（平台预设清单，本文件为唯一来源）
// C 端首页筛选、品牌方提交商品级联下拉、后端提交校验均引用此处；
// 调整类目结构只需改 PRODUCT_CATEGORIES（后期需求变化可随时扩展）。
// 放在 shared 层：features/products 与 features/brand 均可引用，且不违反模块边界。

export interface ProductCategory {
  category: string;
  subcategories: string[];
}

export const PRODUCT_CATEGORIES: ProductCategory[] = [
  {
    category: "成人计生用品",
    // ⚠️ 避孕套属二类医疗器械，质检时需资质把控
    subcategories: ["避孕套", "润滑液"],
  },
  {
    category: "情趣用品",
    subcategories: ["震动器具", "男用器具", "女用器具", "情趣内衣", "情趣玩具套装"],
  },
  {
    category: "智能设备",
    subcategories: ["智能健康监测", "智能情趣设备"],
  },
  {
    category: "身体护理",
    subcategories: ["身体乳/润体", "私密护理"],
  },
  {
    category: "其他",
    subcategories: ["其他"],
  },
];

/** 指定大类的子类列表；未知大类返回空数组 */
export function getSubcategories(category: string): string[] {
  return PRODUCT_CATEGORIES.find((node) => node.category === category)?.subcategories ?? [];
}

/** 校验「大类 + 子类」是否为合法组合（子类为空 / 未知 / 不属于该大类 → false） */
export function isValidCategoryPair(
  category: string,
  subcategory: string | null | undefined,
): boolean {
  if (!subcategory) return false;
  return getSubcategories(category).includes(subcategory);
}
