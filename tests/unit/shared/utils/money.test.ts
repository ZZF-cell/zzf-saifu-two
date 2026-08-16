// money 单元测试 — 金额工具全覆盖（L12：README 声称金额工具 100%，此前无专属测试，
// 仅靠其他模块间接覆盖 87.5%）。基于 big.js，全整数分语义。
// 边界：0、负数、小数点精度、分摊舍入修正分支。

import { describe, it, expect } from "vitest";
import {
  yuanToFen,
  fenToYuan,
  multiplyFen,
  sumFen,
  distributeDiscount,
} from "@/shared/utils/money";

describe("yuanToFen — 元 → 分（整数存储）", () => {
  it("常规金额", () => {
    expect(yuanToFen("12.34")).toBe(1234);
    expect(yuanToFen(0)).toBe(0);
    expect(yuanToFen("299")).toBe(29900);
  });

  it("负数金额", () => {
    expect(yuanToFen("-5.5")).toBe(-550);
  });

  it("超小数位四舍五入到分", () => {
    // big.js round(0) 默认 half-up：12.345 元 → 1234.5 分 → 1235
    expect(yuanToFen("12.345")).toBe(1235);
    expect(yuanToFen("0.001")).toBe(0);
  });
});

describe("fenToYuan — 分 → 元（展示，固定两位小数）", () => {
  it("正常/零/负数", () => {
    expect(fenToYuan(29900)).toBe("299.00");
    expect(fenToYuan(0)).toBe("0.00");
    expect(fenToYuan(-550)).toBe("-5.50");
  });
});

describe("multiplyFen — 分 × 数量", () => {
  it("整分乘法", () => {
    expect(multiplyFen(100, 3)).toBe(300);
    expect(multiplyFen(333, 3)).toBe(999);
  });

  it("非整数结果四舍五入（单价 0.33 分 × 2）", () => {
    // 0.33 × 2 = 0.66 → 四舍五入 1
    expect(multiplyFen(1, 0.5)).toBe(1);
  });

  it("零与负数", () => {
    expect(multiplyFen(0, 5)).toBe(0);
    expect(multiplyFen(100, -1)).toBe(-100);
  });
});

describe("sumFen — 分数组求和", () => {
  it("多元素求和", () => {
    expect(sumFen([1, 2, 3])).toBe(6);
  });

  it("空数组 → 0", () => {
    expect(sumFen([])).toBe(0);
  });

  it("含零与负数", () => {
    expect(sumFen([0, -5, 5])).toBe(0);
  });
});

describe("distributeDiscount — 按金额比例分摊折扣", () => {
  it("等额分摊：100/100/100，折扣 200 → 每行 33，最后一笔吸收舍入差变 34", () => {
    // rate=(300-200)/300=1/3；100×(1/3)≈33.33→33；三行合计 99；差额 1 加到末笔
    expect(distributeDiscount([100, 100, 100], 200)).toEqual([33, 33, 34]);
  });

  it("无折扣 → 金额原样", () => {
    expect(distributeDiscount([300, 100], 0)).toEqual([300, 100]);
  });

  it("total=0（无商品行）→ 全 0，防除零", () => {
    expect(distributeDiscount([0, 0], 0)).toEqual([0, 0]);
  });

  it("单行 → 折扣全吸收", () => {
    expect(distributeDiscount([300], 50)).toEqual([250]);
  });

  it("分摊后与期望总额严格一致", () => {
    const out = distributeDiscount([150, 150, 150, 150], 100);
    expect(sumFen(out)).toBe(500);
  });
});
