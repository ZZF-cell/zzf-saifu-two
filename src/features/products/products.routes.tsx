"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import NextImage from "next/image";
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
  // 请求序号守卫：快速连点类目/排序时只应用「最后一次」请求的结果，
  // 丢弃晚到的旧响应，杜绝网格内容在 A/B/C 类目间来回闪跳（多次切类抖动主因）。
  const reqSeq = useRef(0);

  const fetchProducts = useCallback(async () => {
    const seq = ++reqSeq.current;
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
      // 过期响应：seq 落后于最新 → 直接丢弃，不触碰任何 state
      if (seq !== reqSeq.current) return;
      if (res.ok) {
        setProducts(data.items);
        setTotalPages(data.totalPages);
      } else {
        // 接口返回错误（如 500）→ 保留旧列表并提示，避免整页白屏
        setLoadError(data.message || "商品加载失败，请稍后重试");
      }
    } catch {
      // 网络异常/JSON 解析失败 → 不抛出未处理 rejection，提示后保留旧列表
      if (seq !== reqSeq.current) return;
      setLoadError("网络异常，商品加载失败");
    } finally {
      // 仅最新请求有权结束 loading，防止旧响应翻转加载状态
      if (seq === reqSeq.current) setLoading(false);
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

  const handleSortChange = (s: { sortBy: string; sortOrder: string }) => {
    // 排序变化改变结果集：翻到末页切排序会得到空列表，必须与搜索/类目筛选一致回第 1 页
    setPage(1);
    setSort(s);
  };

  return (
    <main className="min-h-screen bg-white">
      <SiteHeader />
      <div className="mx-auto max-w-6xl px-4 py-4">

        {/* 运营横幅：彩色渐变商城风（from-primary 深蓝黑 → accent 玫红）+ 品牌 LOGO 白底圆章 */}
        <div className="mb-4 flex items-center gap-4 overflow-hidden rounded-2xl bg-linear-to-r from-primary via-primary-light to-accent px-6 py-6 text-white shadow-lg">
          <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full bg-white shadow-inner">
            {/* ⚠️ 品牌 LOGO 必须用 next/image 直连，不能走共享 Image（image-source 只认
                data:/https:，本地 /icons 路径会被替换成「暂无图片」占位图） */}
            <NextImage
              src="/icons/icon-192x192.png"
              alt="赛夫严选"
              width={64}
              height={64}
              className="h-14 w-14"
              priority
            />
          </div>
          <div>
            <p className="text-2xl font-bold tracking-wide">赛夫严选 · 品质严选</p>
            <p className="mt-1 text-sm text-white/80">成人用品正品保障 · 全流程隐私发货</p>
          </div>
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
              activeCategory={category}
              activeSubCategory={subCategory}
              onCategoryChange={handleCategoryChange}
              onSubCategoryChange={handleSubCategoryChange}
            />
          </div>
        )}

        {/* Sort */}
        <div className="mb-4 flex items-center justify-between">
          {/* min-w 固定计数/加载文案宽度，避免 justify-between 下排序按钮随文案重排 */}
          <p className="min-w-20 truncate text-xs text-gray-400">
            {loading ? "加载中..." : `${products.length} 个商品`}
          </p>
          <SortSelector value={sort} onChange={handleSortChange} />
        </div>

        {/* Product Grid：首次加载才显示骨架；分类/排序/翻页刷新时保留旧网格避免高度跳变。
            网格区 min-h-[70vh]：吃住「全部→稀疏类目」的高度差，分页条不随数据量上下跳。
            不置灰旧网格（opacity 切换会闪烁），加载反馈靠排序行「加载中...」 */}
        <div className="min-h-[70vh]">
          {loading && products.length === 0 ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {Array.from({ length: 8 }).map((_, i) => (
                // 骨架结构与 ProductCard（方形图 + 文本块）对齐，切换时不产生高度差
                <div
                  key={i}
                  className="overflow-hidden rounded-xl border border-border bg-white"
                >
                  <div className="aspect-square animate-pulse bg-gray-100" />
                  <div className="space-y-2 p-3">
                    <div className="h-4 w-3/4 animate-pulse rounded bg-gray-100" />
                    <div className="h-5 w-1/3 animate-pulse rounded bg-gray-100" />
                    <div className="h-3 w-1/4 animate-pulse rounded bg-gray-100" />
                  </div>
                </div>
              ))}
            </div>
          ) : loadError && products.length === 0 ? (
            <div className="flex min-h-[70vh] flex-col items-center justify-center text-center text-gray-400">
              <p className="text-lg">{loadError}</p>
            </div>
          ) : (
            <div className={loading ? "pointer-events-none" : ""}>
              <ProductGrid products={products} />
            </div>
          )}
        </div>

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
  // #11 加购失败提示：库存不足/已下架/网络异常都给出可见反馈，而非静默失败
  const [addError, setAddError] = useState("");
  // #12 请求序号守卫：快速切换商品时丢弃晚到的旧响应 + 清理时 abort，
  // 杜绝旧商品数据覆盖新商品（详情页内容闪跳/错乱）
  const reqSeq = useRef(0);

  useEffect(() => {
    const seq = ++reqSeq.current;
    const controller = new AbortController();
    fetch(`/api/products/${id}`, { signal: controller.signal })
      .then((res) => res.json())
      .then((data) => {
        if (seq !== reqSeq.current) return; // 旧响应丢弃
        if (data.error) {
          router.push("/");
          return;
        }
        setProduct(data);
      })
      .catch((err) => {
        // 主动 abort（id 变化清理触发）不算网络错误，不跳首页
        if (err.name !== "AbortError" && seq === reqSeq.current) router.push("/");
      })
      .finally(() => {
        if (seq === reqSeq.current) setLoading(false);
      });
    return () => controller.abort();
  }, [id, router]);

  if (loading) {
    return (
      <main className="mx-auto min-h-screen max-w-2xl p-4">
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
    <main className="mx-auto min-h-screen max-w-2xl bg-white pb-24">
      {/* 图片轮播 */}
      <div className="relative aspect-square bg-gray-50">
        {/* 返回：深链直达时无历史记录则回首页，避免浏览器退出 */}
        <button
          onClick={() =>
            window.history.length > 1 ? router.back() : router.push("/")
          }
          aria-label="返回"
          className="absolute left-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-black/30 text-lg text-white backdrop-blur transition hover:bg-black/50"
        >
          ←
        </button>
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
        <div className="mx-auto max-w-2xl">
          {/* 加购失败提示（#11）：库存不足/已下架/网络异常均可见 */}
          {addError && (
            <p className="mb-2 text-center text-sm text-red-500">{addError}</p>
          )}
          <div className="flex gap-3">
            <button
              onClick={() => {
                setAddError("");
                // apiFetch：未登录/401 自动刷新 Token；Refresh 失效时自行跳登录页
                apiFetch("/api/cart", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ productId: product.id, qty: 1 }),
                })
                  .then((res) => res.json())
                  .then((data) => {
                    if (data.success) {
                      router.push("/cart");
                      return;
                    }
                    if (data.error === "UNAUTHORIZED") {
                      router.push("/login");
                      return;
                    }
                    if (data.error === "FORBIDDEN") {
                      // 非 USER 角色账号无购物车权限（服务端 requireRole 守卫）
                      setAddError("当前账号无购物车权限，请联系管理员");
                      return;
                    }
                    // 其余失败（STOCK_CONFLICT 库存不足等）展示后端 message
                    setAddError(data.message || "加入购物车失败，请稍后重试");
                  })
                  .catch(() => setAddError("网络异常，加入购物车失败"));
              }}
              disabled={product.stock === 0}
              className="flex-1 rounded-lg bg-primary py-3 text-center text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
            >
              {product.stock === 0 ? "已售罄" : "加入购物车"}
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
