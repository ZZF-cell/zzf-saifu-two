"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { CartItemRow, EmptyCart } from "./cart.components";
import type { CartItemData } from "./cart.components";
import { fenToYuan, sumFen } from "@/shared/utils/money";
import { SiteHeader } from "@/shared/ui/SiteHeader";

interface CartData {
  items: CartItemData[];
  totalCount: number;
  totalAmount: number;
}

type ApiError = { error?: string; message?: string };

export function CartPage() {
  const router = useRouter();
  const [cart, setCart] = useState<CartData | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  // 部分结算勾选集（按 productId）
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const fetchCart = useCallback(async () => {
    try {
      const res = await fetch("/api/cart", { credentials: "include" });
      if (res.status === 401) {
        router.push("/login");
        return;
      }
      const data = await res.json();
      if (res.ok) {
        setCart(data);
        // prune：删除/改数量后清掉已消失项的勾选，避免结算时带不存在的商品
        setSelectedIds((prev) => {
          const valid = data.items.map((i: CartItemData) => i.productId);
          const next = new Set([...prev].filter((id) => valid.includes(id)));
          return next.size === prev.size ? prev : next;
        });
      } else setErrorMsg(data.message || "加载购物车失败");
    } catch {
      setErrorMsg("网络错误，请稍后重试");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    fetchCart();
  }, [fetchCart]);

  const patchCart = async (url: string, body: Record<string, unknown>) => {
    if (updating) return;
    setUpdating(true);
    setErrorMsg("");
    try {
      const res = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        credentials: "include",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as ApiError;
        if (res.status === 401 || data.error === "UNAUTHORIZED") { router.push("/login"); return; }
        setErrorMsg(data.message || "操作失败，请重试");
        return;
      }
      await fetchCart();
    } catch {
      setErrorMsg("网络错误，请稍后重试");
    } finally {
      setUpdating(false);
    }
  };

  const deleteItem = async (productId: string) => {
    if (updating) return;
    setUpdating(true);
    setErrorMsg("");
    try {
      const res = await fetch("/api/cart", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId }),
        credentials: "include",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as ApiError;
        if (res.status === 401 || data.error === "UNAUTHORIZED") { router.push("/login"); return; }
        setErrorMsg(data.message || "删除失败，请重试");
        return;
      }
      await fetchCart();
    } catch {
      setErrorMsg("网络错误，请稍后重试");
    } finally {
      setUpdating(false);
    }
  };

  const handleQtyChange = (productId: string, qty: number) => {
    if (qty < 1) {
      deleteItem(productId);
      return;
    }
    patchCart("/api/cart", { productId, qty });
  };

  // ── 部分结算勾选 ──

  const toggleItem = (productId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  };

  const items = cart?.items ?? [];
  const allSelected = items.length > 0 && items.every((i) => selectedIds.has(i.productId));

  const toggleAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(items.map((i) => i.productId)));
  };

  const selectedItems = items.filter((i) => selectedIds.has(i.productId));
  const selectedCount = selectedItems.reduce((s, i) => s + i.qty, 0);
  // 结算条金额只统计选中项（sumFen 为空数组返回 0）
  const selectedAmount = sumFen(selectedItems.map((i) => i.subtotal));

  const goCheckout = () => {
    if (selectedItems.length === 0) {
      setErrorMsg("请先勾选要结算的商品");
      return;
    }
    const ids = selectedItems.map((i) => i.productId).join(",");
    router.push(`/checkout?items=${encodeURIComponent(ids)}`);
  };

  if (loading) {
    return (
      <main className="mx-auto min-h-screen max-w-6xl bg-white pb-32">
        <SiteHeader />
        <div className="mx-auto w-full max-w-2xl">
          <div className="flex items-center gap-2 px-4 pt-4">
            <button
              onClick={() => router.push("/")}
              className="shrink-0 rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 transition hover:bg-gray-50"
            >
              ← 返回首页
            </button>
            <h1 className="flex-1 text-center text-base font-bold">购物车</h1>
          </div>
          <div className="mt-6 space-y-3 px-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-24 animate-pulse rounded-xl bg-gray-100" />
            ))}
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-screen max-w-6xl bg-white pb-32">
      <SiteHeader />
      <div className="mx-auto w-full max-w-2xl">
        <div className="flex items-center gap-2 px-4 pt-4">
          <button
            onClick={() => router.push("/")}
            className="shrink-0 rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 transition hover:bg-gray-50"
          >
            ← 返回首页
          </button>
          <h1 className="flex-1 text-center text-base font-bold">
            购物车 ({cart?.totalCount || 0})
          </h1>
        </div>

        <div className="p-4">
          {errorMsg && (
            <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
              {errorMsg}
              <button onClick={() => setErrorMsg("")} className="ml-2 underline">关闭</button>
            </div>
          )}

          {!cart || cart.items.length === 0 ? (
            <EmptyCart />
          ) : (
            <div className="space-y-3">
              {cart.items.map((item) => (
                <CartItemRow
                  key={item.id}
                  item={item}
                  checked={selectedIds.has(item.productId)}
                  onToggleChecked={toggleItem}
                  onQtyChange={handleQtyChange}
                  onRemove={deleteItem}
                  disabled={updating}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {cart && cart.items.length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 border-t bg-white px-4 py-3">
          <div className="mx-auto flex max-w-2xl items-center justify-between gap-3">
            <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-sm text-gray-600">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                aria-label="全选"
                className="h-5 w-5 accent-primary"
              />
              全选
            </label>
            <div className="flex-1 text-right">
              <p className="text-xs text-gray-500">已选 {selectedCount} 件</p>
              <p className="text-xl font-bold text-primary">
                ¥{fenToYuan(selectedAmount)}
              </p>
              <p className="text-xs text-gray-400">价格以结算时为准</p>
            </div>
            <button
              onClick={goCheckout}
              disabled={selectedItems.length === 0 || updating}
              className="shrink-0 rounded-lg bg-primary px-6 py-3 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
            >
              去结算{selectedItems.length > 0 ? `(${selectedItems.length})` : ""}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
