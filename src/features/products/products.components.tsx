"use client";

import Link from "next/link";
import Image from "@/shared/ui/Image";
import { fenToYuan } from "@/shared/utils/money";

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
    return (
      <div className="flex flex-col items-center justify-center py-20 text-gray-400">
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

// ── 分类筛选器 ──

interface CategoryFilterProps {
  categories: string[];
  active: string | undefined;
  onChange: (category: string | undefined) => void;
}

export function CategoryFilter({
  categories,
  active,
  onChange,
}: CategoryFilterProps) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-2">
      <button
        onClick={() => onChange(undefined)}
        className={`whitespace-nowrap rounded-full px-4 py-1.5 text-xs font-medium transition ${
          !active
            ? "bg-primary text-white"
            : "bg-gray-100 text-gray-600 hover:bg-gray-200"
        }`}
      >
        全部
      </button>
      {categories.map((cat) => (
        <button
          key={cat}
          onClick={() => onChange(cat)}
          className={`whitespace-nowrap rounded-full px-4 py-1.5 text-xs font-medium transition ${
            active === cat
              ? "bg-primary text-white"
              : "bg-gray-100 text-gray-600 hover:bg-gray-200"
          }`}
        >
          {cat}
        </button>
      ))}
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
