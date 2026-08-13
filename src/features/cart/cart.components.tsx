"use client";

import Link from "next/link";
import Image from "@/shared/ui/Image";
import { fenToYuan } from "@/shared/utils/money";

// ── 类型 ──

export interface CartItemData {
  id: string;
  productId: string;
  productName: string;
  price: number;
  qty: number;
  image: string | null;
  stock: number;
  subtotal: number;
}

// ── 购物车单项 ──

interface CartItemRowProps {
  item: CartItemData;
  onQtyChange: (productId: string, qty: number) => void;
  onRemove: (productId: string) => void;
  disabled?: boolean;
}

export function CartItemRow({
  item,
  onQtyChange,
  onRemove,
  disabled,
}: CartItemRowProps) {
  return (
    <div className="flex gap-3 rounded-xl border border-gray-100 p-3">
      {/* 图片 */}
      <Link href={`/products/${item.productId}`} className="shrink-0">
        <Image
          src={item.image}
          alt={item.productName}
          width={80}
          height={80}
          className="rounded-lg object-cover bg-gray-50"
        />
      </Link>

      {/* 信息 + 操作 */}
      <div className="flex flex-1 flex-col justify-between">
        <div>
          <Link
            href={`/products/${item.productId}`}
            className="text-sm font-medium text-gray-900 line-clamp-2"
          >
            {item.productName}
          </Link>
          <p className="mt-0.5 text-sm font-bold text-primary">
            ¥{fenToYuan(item.price)}
          </p>
        </div>

        <div className="flex items-center justify-between">
          {/* 数量选择器 */}
          <div className="flex items-center rounded-lg border border-gray-200">
            <button
              onClick={() => onQtyChange(item.productId, item.qty - 1)}
              disabled={disabled || item.qty <= 1}
              className="px-2.5 py-1 text-sm text-gray-500 transition disabled:opacity-30"
            >
              −
            </button>
            <span className="px-2 text-sm font-medium tabular-nums">
              {item.qty}
            </span>
            <button
              onClick={() => onQtyChange(item.productId, item.qty + 1)}
              disabled={disabled || item.qty >= item.stock}
              className="px-2.5 py-1 text-sm text-gray-500 transition disabled:opacity-30"
            >
              +
            </button>
          </div>

          <button
            onClick={() => onRemove(item.productId)}
            disabled={disabled}
            className="text-xs text-gray-400 transition hover:text-red-500 disabled:opacity-30"
          >
            删除
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 空购物车 ──

export function EmptyCart() {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-gray-400">
      <p className="text-lg">购物车是空的</p>
      <Link
        href="/"
        className="mt-3 rounded-lg bg-primary px-6 py-2 text-sm font-medium text-white transition hover:opacity-90"
      >
        去逛逛
      </Link>
    </div>
  );
}
