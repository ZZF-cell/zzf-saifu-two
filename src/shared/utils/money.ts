// 金额处理 — 基于 big.js，所有金额计算必须通过此模块
// 规则：内部以「分」为单位的整数存储，展示时除以 100

import Big from "big.js";

/** 元 → 分（内部存储单位） */
export function yuanToFen(yuan: number | string): number {
  return new Big(yuan).times(100).round(0).toNumber();
}

/** 分 → 元（展示用） */
export function fenToYuan(fen: number): string {
  return new Big(fen).div(100).toFixed(2);
}

/** 乘法（分 × 数量） */
export function multiplyFen(fen: number, qty: number): number {
  return new Big(fen).times(qty).round(0).toNumber();
}

/** 求和（分数组） */
export function sumFen(fens: number[]): number {
  return fens.reduce((acc, f) => new Big(acc).plus(f).toNumber(), 0);
}

/** 优惠分摊（按金额比例分配到各订单行，返回每个分摊后的分） */
export function distributeDiscount(
  itemAmounts: number[],
  totalDiscount: number,
): number[] {
  const total = sumFen(itemAmounts);
  if (total === 0) return itemAmounts.map(() => 0);

  const rate = new Big(total).minus(totalDiscount).div(total);
  const distributed = itemAmounts.map((a) =>
    new Big(a).times(rate).round(0).toNumber(),
  );

  // 修正舍入误差：将差额加到最后一笔
  const distributedTotal = sumFen(distributed);
  const diff = new Big(total).minus(totalDiscount).minus(distributedTotal).toNumber();
  if (diff !== 0 && distributed.length > 0) {
    distributed[distributed.length - 1] = new Big(distributed[distributed.length - 1])
      .plus(diff)
      .toNumber();
  }

  return distributed;
}
