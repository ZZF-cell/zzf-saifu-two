"use client";

import { useState, useEffect, useCallback } from "react";
import Image from "@/shared/ui/Image";
import { SiteHeader } from "@/shared/ui/SiteHeader";
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
import { apiFetch } from "@/shared/api/client";
import type { ProductCategory } from "@/shared/constants/product-categories";

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
  const [products, setProducts] = useState<ProductCardData[]>([]);
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [activeSearch, setActiveSearch] = useState("");
  const [category, setCategory] = useState<string | undefined>();
  const [subCategory, setSubCategory] = useState<string | undefined>();
  const [sort, setSort] = useState({ sortBy: "createdAt", sortOrder: "desc" });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const fetchProducts = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("pageSize", "20");
      params.set("sortBy", sort.sortBy);
      params.set("sortOrder", sort.sortOrder);
      if (activeSearch) params.set("search", activeSearch);
      if (category) params.set("category", category);
      if (subCategory) params.set("subCategory", subCategory);

      const res = await fetch(`/api/products?${params.toString()}`);
      // 错误响应形如 { error, message }，与成功响应 ProductListResponse 并存
      const data = (await res.json()) as ProductListResponse & { message?: string };
      if (res.ok) {
        setProducts(data.items);
        setTotalPages(data.totalPages);
      } else {
        // 接口返回错误（如 500）→ 保留旧列表并提示，避免整页白屏
        setLoadError(data.message || "商品加载失败，请稍后重试");
      }
    } catch {
      // 网络异常/JSON 解析失败 → 不抛出未处理 rejection，提示后保留旧列表
      setLoadError("网络异常，商品加载失败");
    } finally {
      setLoading(false);
    }
  }, [page, activeSearch, category, subCategory, sort]);

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
    setSubCategory(undefined); // 切换大类时清空子类，回到该大类全部
  };

  const handleSubCategoryChange = (sub: string | undefined) => {
    setPage(1);
    setSubCategory(sub);
  };

  return (
    <main className="min-h-screen bg-white">
      <SiteHeader />
      <div className="mx-auto max-w-6xl px-4 py-4">

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
              activeCategory={category}
              activeSubCategory={subCategory}
              onCategoryChange={handleCategoryChange}
              onSubCategoryChange={handleSubCategoryChange}
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
        ) : loadError && products.length === 0 ? (
          <div className="py-20 text-center text-gray-400">
            <p className="text-lg">{loadError}</p>
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
  subCategory: string | null;
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

  // 空数组时 images[selectedImage] 为 undefined，SharedImage 内部回退占位图
  const images = product.images;

  return (
    <main className="mx-auto min-h-screen max-w-lg bg-white pb-24">
      {/* 图片轮播 */}
      <div className="relative aspect-square bg-gray-50">
        <Image
          src={images[selectedImage]}
          alt={product.name}
          fill
          sizes="(max-width: 640px) 100vw, 50vw"
          className="object-cover"
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
          <span>
            {product.category}
            {product.subCategory ? ` / ${product.subCategory}` : ""}
          </span>
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
              // apiFetch：未登录/401 自动刷新 Token；Refresh 失效时自行跳登录页
              apiFetch("/api/cart", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ productId: product.id, qty: 1 }),
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
