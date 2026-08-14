"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import Image from "@/shared/ui/Image";
import { fenToYuan } from "@/shared/utils/money";
import { type ProductCategory, categoryEmoji } from "@/shared/constants/product-categories";

// ── 类型 ──

export interface ProductCardData {
  id: string;
  name: string;
  price: number; // 分
  images: string[];
  category: string;
  sales: number;
}

// ── 商品卡片 ──

export function ProductCard({ product }: { product: ProductCardData }) {
  return (
    <Link
      href={`/products/${product.id}`}
      className="group block overflow-hidden rounded-xl border border-border bg-white transition hover:shadow-md"
    >
      <div className="relative aspect-square bg-gray-50">
        <Image
          src={product.images?.[0]}
          alt={product.name}
          fill
          sizes="(max-width: 768px) 50vw, 33vw"
          className="object-cover"
        />
        {product.sales > 0 && (
          <span className="absolute right-1.5 top-1.5 rounded-full bg-linear-to-r from-primary to-accent px-2 py-0.5 text-[10px] font-medium text-white">
            已售 {product.sales}
          </span>
        )}
      </div>
      <div className="p-3">
        <h3 className="text-sm font-medium leading-tight text-gray-900 group-hover:text-primary">
          {product.name}
        </h3>
        <div className="mt-1.5 flex items-baseline gap-1">
          <span className="text-lg font-bold text-primary">
            ¥{fenToYuan(product.price)}
          </span>
        </div>
        <p className="mt-1 text-xs text-gray-400">已售 {product.sales}</p>
      </div>
    </Link>
  );
}

// ── 商品网格 ──

export function ProductGrid({ products }: { products: ProductCardData[] }) {
  if (products.length === 0) {
    // min-h 与网格区一致（外层同为 min-h-[70vh]），空态不产生高度跳变
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center text-gray-400">
        <p className="text-lg">暂无商品</p>
        <p className="mt-2 text-sm">换个关键词试试</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {products.map((p) => (
        <ProductCard key={p.id} product={p} />
      ))}
    </div>
  );
}

// ── 分类筛选器（两级：大类 pill 行 + 选中大类后的子类 pill 行） ──

interface CategoryFilterProps {
  categories: ProductCategory[];
  activeCategory: string | undefined;
  activeSubCategory: string | undefined;
  onCategoryChange: (category: string | undefined) => void;
  onSubCategoryChange: (subCategory: string | undefined) => void;
}

export function CategoryFilter({
  categories,
  activeCategory,
  activeSubCategory,
  onCategoryChange,
  onSubCategoryChange,
}: CategoryFilterProps) {
  const activeNode = categories.find((n) => n.category === activeCategory);
  const subcategories = activeNode?.subcategories ?? [];
  const showSubRow = activeCategory && subcategories.length > 0;
  // 切大类时子类 pill 集合瞬变，横向滚动位置可能停在旧偏移 → 切回起点
  const subScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (subScrollRef.current) subScrollRef.current.scrollLeft = 0;
  }, [activeCategory]);

  return (
    <div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        <button
          onClick={() => onCategoryChange(undefined)}
          className={`whitespace-nowrap rounded-full px-4 py-1.5 text-xs font-medium transition ${
            !activeCategory
              ? "bg-linear-to-r from-primary to-accent text-white"
              : "bg-gray-100 text-gray-600 hover:bg-gray-200"
          }`}
        >
          全部
        </button>
        {categories.map((node) => (
          <button
            key={node.category}
            onClick={() => onCategoryChange(node.category)}
            className={`whitespace-nowrap rounded-full px-4 py-1.5 text-xs font-medium transition ${
              activeCategory === node.category
                ? "bg-linear-to-r from-primary to-accent text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {categoryEmoji(node.category)} {node.category}
          </button>
        ))}
      </div>

      {/* 子类行：key 绑定大类 → 切大类时整块重挂载，跳过 grid-rows 补间动画。
          快速连点不再打断半展开动画造成抖动；展开/收起随新 key 瞬时到位 */}
      <div
        key={activeCategory}
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${
          showSubRow ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="min-h-0 overflow-hidden">
          {showSubRow && (
            <div ref={subScrollRef} className="flex gap-2 overflow-x-auto pb-1 pt-2">
              <button
                onClick={() => onSubCategoryChange(undefined)}
                className={`whitespace-nowrap rounded-full px-4 py-1.5 text-xs font-medium transition ${
                  !activeSubCategory
                    ? "bg-primary/10 text-primary"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                全部子类
              </button>
              {subcategories.map((sub) => (
                <button
                  key={sub}
                  onClick={() => onSubCategoryChange(sub)}
                  className={`whitespace-nowrap rounded-full px-4 py-1.5 text-xs font-medium transition ${
                    activeSubCategory === sub
                      ? "bg-linear-to-r from-primary to-accent text-white"
                      : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}
                >
                  {sub}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── 搜索栏 ──

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder?: string;
}

export function SearchBar({
  value,
  onChange,
  onSubmit,
  placeholder = "搜索商品...",
}: SearchBarProps) {
  return (
    <div className="flex gap-2">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onSubmit()}
        placeholder={placeholder}
        className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
      />
      <button
        onClick={onSubmit}
        className="rounded-lg bg-primary px-5 py-2 text-sm font-medium text-white transition hover:opacity-90"
      >
        搜索
      </button>
    </div>
  );
}

// ── 排序选择器 ──

interface SortSelectorProps {
  value: { sortBy: string; sortOrder: string };
  onChange: (sort: { sortBy: string; sortOrder: string }) => void;
}

export function SortSelector({ value, onChange }: SortSelectorProps) {
  const options = [
    { label: "最新", sortBy: "createdAt", sortOrder: "desc" },
    { label: "价格 ↑", sortBy: "price", sortOrder: "asc" },
    { label: "价格 ↓", sortBy: "price", sortOrder: "desc" },
    { label: "销量", sortBy: "sales", sortOrder: "desc" },
  ];

  return (
    <div className="flex gap-2">
      {options.map((opt) => {
        const isActive =
          value.sortBy === opt.sortBy && value.sortOrder === opt.sortOrder;
        return (
          <button
            key={opt.label}
            onClick={() =>
              onChange({ sortBy: opt.sortBy, sortOrder: opt.sortOrder })
            }
            className={`rounded-md px-3 py-1 text-xs font-medium transition ${
              isActive
                ? "bg-primary/10 text-primary"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ── 分页器 ──

interface PaginationProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}

export function Pagination({
  page,
  totalPages,
  onPageChange,
}: PaginationProps) {
  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-center gap-2">
      <button
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1}
        className="rounded-md px-3 py-1 text-sm text-gray-600 transition disabled:opacity-30"
      >
        上一页
      </button>
      <span className="text-sm text-gray-500">
        {page} / {totalPages}
      </span>
      <button
        onClick={() => onPageChange(page + 1)}
        disabled={page >= totalPages}
        className="rounded-md px-3 py-1 text-sm text-gray-600 transition disabled:opacity-30"
      >
        下一页
      </button>
    </div>
  );
}
