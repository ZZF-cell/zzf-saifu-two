"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { CartItemRow, EmptyCart } from "./cart.components";
import type { CartItemData } from "./cart.components";
import { fenToYuan } from "@/shared/utils/money";
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

  const fetchCart = useCallback(async () => {
    try {
      const res = await fetch("/api/cart", { credentials: "include" });
      if (res.status === 401) {
        router.push("/login");
        return;
      }
      const data = await res.json();
      if (res.ok) setCart(data);
      else setErrorMsg(data.message || "加载购物车失败");
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
          <div className="mx-auto flex max-w-2xl items-center justify-between">
            <div>
              <p className="text-xs text-gray-500">共 {cart.totalCount} 件</p>
              <p className="text-xl font-bold text-primary">
                ¥{fenToYuan(cart.totalAmount)}
              </p>
              <p className="text-xs text-gray-400">价格以结算时为准</p>
            </div>
            <button
              onClick={() => router.push("/checkout")}
              disabled={updating}
              className="rounded-lg bg-primary px-8 py-3 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
            >
              去结算
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
