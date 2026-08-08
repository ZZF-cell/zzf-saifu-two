"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  ProductGrid,
  CategoryFilter,
  SearchBar,
  SortSelector,
  Pagination,
} from "./products.components";
import type { ProductCardData } from "./products.components";
import { fenToYuan } from "@/shared/utils/money";

// ── API helpers ──

interface ProductListResponse {
  items: ProductCardData[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// ── 首页（商品列表） ──

export function HomePage() {
  const router = useRouter();
  const [products, setProducts] = useState<ProductCardData[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [activeSearch, setActiveSearch] = useState("");
  const [category, setCategory] = useState<string | undefined>();
  const [sort, setSort] = useState({ sortBy: "createdAt", sortOrder: "desc" });
  const [loading, setLoading] = useState(true);

  const fetchProducts = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("pageSize", "20");
      params.set("sortBy", sort.sortBy);
      params.set("sortOrder", sort.sortOrder);
      if (activeSearch) params.set("search", activeSearch);
      if (category) params.set("category", category);

      const res = await fetch(`/api/products?${params.toString()}`);
      const data: ProductListResponse = await res.json();
      if (res.ok) {
        setProducts(data.items);
        setTotalPages(data.totalPages);
      }
    } finally {
      setLoading(false);
    }
  }, [page, activeSearch, category, sort]);

  const fetchCategories = useCallback(async () => {
    try {
      const res = await fetch("/api/products/categories");
      const data = await res.json();
      if (res.ok) setCategories(data.categories);
    } catch { /* 静默失败 */ }
  }, []);

  useEffect(() => {
    fetchProducts();
    fetchCategories();
  }, [fetchProducts, fetchCategories]);

  const handleSearch = () => {
    setPage(1);
    setActiveSearch(search);
  };

  const handleCategoryChange = (cat: string | undefined) => {
    setPage(1);
    setCategory(cat);
  };

  return (
    <main className="min-h-screen bg-white">
      <div className="mx-auto max-w-6xl px-4 py-4">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-xl font-bold tracking-tight">赛夫严选</h1>
          <button
            onClick={() => router.push("/login")}
            className="text-sm text-gray-500"
          >
            登录
          </button>
        </div>

        {/* Search */}
        <div className="mb-4">
          <SearchBar
            value={search}
            onChange={setSearch}
            onSubmit={handleSearch}
          />
        </div>

        {/* Categories */}
        {categories.length > 0 && (
          <div className="mb-4">
            <CategoryFilter
              categories={categories}
              active={category}
              onChange={handleCategoryChange}
            />
          </div>
        )}

        {/* Sort */}
        <div className="mb-4 flex items-center justify-between">
          <p className="text-xs text-gray-400">
            {loading ? "加载中..." : `${products.length} 个商品`}
          </p>
          <SortSelector value={sort} onChange={setSort} />
        </div>

        {/* Product Grid */}
        {loading ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="aspect-[3/4] animate-pulse rounded-xl bg-gray-100"
              />
            ))}
          </div>
        ) : (
          <ProductGrid products={products} />
        )}

        {/* Pagination */}
        <div className="mt-6 mb-20">
          <Pagination
            page={page}
            totalPages={totalPages}
            onPageChange={setPage}
          />
        </div>
      </div>
    </main>
  );
}

// ── 商品详情页 ──

interface ProductDetailData {
  id: string;
  name: string;
  description: string | null;
  price: number;
  images: string[];
  specs: Record<string, string> | null;
  category: string;
  stock: number;
  sales: number;
  brand: { id: string; name: string };
}

export function ProductDetailPage({ id }: { id: string }) {
  const router = useRouter();
  const [product, setProduct] = useState<ProductDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedImage, setSelectedImage] = useState(0);

  useEffect(() => {
    fetch(`/api/products/${id}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.error) {
          router.push("/");
          return;
        }
        setProduct(data);
      })
      .catch(() => router.push("/"))
      .finally(() => setLoading(false));
  }, [id, router]);

  if (loading) {
    return (
      <main className="mx-auto min-h-screen max-w-lg p-4">
        <div className="aspect-square animate-pulse rounded-xl bg-gray-100" />
        <div className="mt-4 h-6 w-2/3 animate-pulse rounded bg-gray-100" />
        <div className="mt-2 h-4 w-1/3 animate-pulse rounded bg-gray-100" />
      </main>
    );
  }

  if (!product) return null;

  const placeholderImage =
    "data:image/svg+xml," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" fill="%231a1a2e"><rect width="300" height="300"/><text x="150" y="150" fill="%23ffffff33" text-anchor="middle" dy=".3em" font-size="14">暂无图片</text></svg>`,
    );

  const images =
    product.images.length > 0 ? product.images : [placeholderImage];

  return (
    <main className="mx-auto min-h-screen max-w-lg bg-white pb-24">
      {/* 图片轮播 */}
      <div className="relative aspect-square bg-gray-50">
        <img
          src={images[selectedImage] || placeholderImage}
          alt={product.name}
          className="h-full w-full object-cover"
        />
        {images.length > 1 && (
          <div className="absolute bottom-3 left-0 right-0 flex justify-center gap-1.5">
            {images.map((_, i) => (
              <button
                key={i}
                onClick={() => setSelectedImage(i)}
                className={`h-2 w-2 rounded-full transition ${
                  i === selectedImage ? "bg-white" : "bg-white/40"
                }`}
              />
            ))}
          </div>
        )}
      </div>

      {/* 商品信息 */}
      <div className="p-4">
        <p className="text-xs text-gray-400">{product.brand.name}</p>
        <h1 className="mt-1 text-lg font-bold">{product.name}</h1>

        <div className="mt-3 flex items-baseline gap-2">
          <span className="text-2xl font-bold text-primary">
            ¥{fenToYuan(product.price)}
          </span>
        </div>

        <div className="mt-3 flex gap-4 text-xs text-gray-500">
          <span>已售 {product.sales}</span>
          <span>库存 {product.stock}</span>
          <span>{product.category}</span>
        </div>

        {/* 商品描述 */}
        {product.description && (
          <div className="mt-6">
            <h3 className="text-sm font-semibold text-gray-700">商品详情</h3>
            <p className="mt-2 text-sm leading-relaxed text-gray-500 whitespace-pre-wrap">
              {product.description}
            </p>
          </div>
        )}

        {/* 规格参数 */}
        {product.specs && Object.keys(product.specs).length > 0 && (
          <div className="mt-6">
            <h3 className="text-sm font-semibold text-gray-700">规格参数</h3>
            <dl className="mt-2 divide-y divide-gray-100">
              {Object.entries(product.specs).map(([key, value]) => (
                <div
                  key={key}
                  className="flex justify-between py-2 text-sm"
                >
                  <dt className="text-gray-500">{key}</dt>
                  <dd className="text-gray-900">{String(value)}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </div>

      {/* 底部操作栏 */}
      <div className="fixed bottom-0 left-0 right-0 border-t bg-white px-4 py-3">
        <div className="mx-auto flex max-w-lg gap-3">
          <button
            onClick={() => {
              fetch("/api/cart", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ productId: product.id, qty: 1 }),
                credentials: "include",
              })
                .then((res) => res.json())
                .then((data) => {
                  if (data.success) router.push("/cart");
                  else if (data.error === "UNAUTHORIZED") router.push("/login");
                })
                .catch(() => {});
            }}
            disabled={product.stock === 0}
            className="flex-1 rounded-lg bg-primary py-3 text-center text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
          >
            {product.stock === 0 ? "已售罄" : "加入购物车"}
          </button>
        </div>
      </div>
    </main>
  );
}
