// oss.adapter 纯函数单测 — 不 mock，只测导出的纯函数（仿 payment.adapter.timestamp.test.ts）
// 覆盖：env 缺失推导 / URL 拼接 / MIME→扩展名 / key 生成（防路径穿越）/ host 白名单
// 契约：
// - 缺任一必填 OSS_* 变量 → getUnavailableReason 非 null（feature 层据此抛 503）
// - key 生成绝不用客户端文件名，扩展名由白名单 MIME 映射（防路径穿越/特殊字符注入）
// - isOssUrl 只认白名单 host，data URI / 相对路径 / 任意外链一律 false

import { describe, it, expect } from "vitest";
import {
  getMissingOssEnvKeys,
  getUnavailableReason,
  getOssHostsFromEnv,
  getOssPublicUrl,
  getExtensionForMime,
  buildObjectKey,
  isOssUrlForHosts,
  extractOssKeyFromUrl,
  isValidOssKeyStructure,
  isOssUrlOwnedBy,
} from "@/shared/adapters/oss.adapter";

describe("getMissingOssEnvKeys — 缺失必填变量推导", () => {
  it("全缺 → 返回 4 个必填 key", () => {
    expect(getMissingOssEnvKeys({})).toEqual([
      "OSS_ACCESS_KEY_ID",
      "OSS_ACCESS_KEY_SECRET",
      "OSS_BUCKET",
      "OSS_REGION",
    ]);
  });

  it("缺部分 → 只返回缺失的 key", () => {
    expect(
      getMissingOssEnvKeys({
        OSS_ACCESS_KEY_ID: "id",
        OSS_ACCESS_KEY_SECRET: "secret",
        OSS_REGION: "oss-cn-hangzhou",
      }),
    ).toEqual(["OSS_BUCKET"]);
  });

  it("全齐 → 返回空数组", () => {
    expect(
      getMissingOssEnvKeys({
        OSS_ACCESS_KEY_ID: "id",
        OSS_ACCESS_KEY_SECRET: "secret",
        OSS_BUCKET: "bucket",
        OSS_REGION: "oss-cn-hangzhou",
      }),
    ).toEqual([]);
  });
});

describe("getUnavailableReason — 未配置降级标记", () => {
  it("有缺失 → 返回含变量名的文案（非 null）", () => {
    const reason = getUnavailableReason({});
    expect(reason).not.toBeNull();
    expect(reason).toContain("存储未配置");
    expect(reason).toContain("OSS_ACCESS_KEY_ID");
  });

  it("全齐 → null", () => {
    expect(
      getUnavailableReason({
        OSS_ACCESS_KEY_ID: "id",
        OSS_ACCESS_KEY_SECRET: "secret",
        OSS_BUCKET: "bucket",
        OSS_REGION: "oss-cn-hangzhou",
      }),
    ).toBeNull();
  });
});

describe("getOssHostsFromEnv — 白名单 host 推导", () => {
  it("仅默认域名 → hosts 含 {bucket}.{region}.aliyuncs.com", () => {
    expect(
      getOssHostsFromEnv({
        OSS_BUCKET: "mybucket",
        OSS_REGION: "oss-cn-hangzhou",
      }),
    ).toEqual(["mybucket.oss-cn-hangzhou.aliyuncs.com"]);
  });

  it("配了 OSS_PUBLIC_DOMAIN（带协议/尾斜杠）→ 追加归一化后的 host", () => {
    expect(
      getOssHostsFromEnv({
        OSS_BUCKET: "mybucket",
        OSS_REGION: "oss-cn-hangzhou",
        OSS_PUBLIC_DOMAIN: "https://img.example.com/",
      }),
    ).toEqual(["mybucket.oss-cn-hangzhou.aliyuncs.com", "img.example.com"]);
  });
});

describe("getOssPublicUrl — 公开访问 URL 拼接", () => {
  it("未配自定义域名 → https://{bucket}.{region}.aliyuncs.com/{key}", () => {
    expect(
      getOssPublicUrl({ bucket: "mybucket", region: "oss-cn-hangzhou", key: "product/a.jpg" }),
    ).toBe("https://mybucket.oss-cn-hangzhou.aliyuncs.com/product/a.jpg");
  });

  it("配自定义域名（带协议）→ https://{domain}/{key}", () => {
    expect(
      getOssPublicUrl({
        bucket: "mybucket",
        region: "oss-cn-hangzhou",
        key: "product/a.jpg",
        publicDomain: "https://img.example.com",
      }),
    ).toBe("https://img.example.com/product/a.jpg");
  });

  it("自定义域名带尾斜杠 → 不产生 //", () => {
    expect(
      getOssPublicUrl({
        bucket: "mybucket",
        region: "oss-cn-hangzhou",
        key: "brand/a.png",
        publicDomain: "https://img.example.com/",
      }),
    ).toBe("https://img.example.com/brand/a.png");
  });
});

describe("getExtensionForMime — MIME → 扩展名白名单映射", () => {
  it("jpeg/png/webp/pdf 各映射正确", () => {
    expect(getExtensionForMime("image/jpeg")).toBe("jpg");
    expect(getExtensionForMime("image/png")).toBe("png");
    expect(getExtensionForMime("image/webp")).toBe("webp");
    expect(getExtensionForMime("application/pdf")).toBe("pdf");
  });

  it("白名单外 MIME → 抛错（拒绝非白名单内容写库）", () => {
    expect(() => getExtensionForMime("application/octet-stream")).toThrow();
  });
});

describe("buildObjectKey — 安全 key 生成", () => {
  it("格式 {folder}/{userId}/{YYYYMMDD}/{uuid}.{ext}，扩展名由 MIME 映射", () => {
    const key = buildObjectKey({
      folder: "product",
      userId: "user-1",
      mime: "image/jpeg",
      randomId: "abc123",
      date: new Date("2026-08-14T00:00:00Z"),
    });
    expect(key).toBe("product/user-1/20260814/abc123.jpg");
  });

  it("不含客户端文件名（只由白名单输入拼装，防路径穿越）", () => {
    const key = buildObjectKey({
      folder: "brand",
      userId: "user-2",
      mime: "image/png",
      randomId: "xyz789",
      date: new Date("2026-08-14T12:30:00Z"),
    });
    expect(key).toBe("brand/user-2/20260814/xyz789.png");
    expect(key).not.toContain("../../");
  });

  it("PDF 证书 → cert/{userId}/{date}/{uuid}.pdf（purpose=cert 走 cert 目录）", () => {
    const key = buildObjectKey({
      folder: "cert",
      userId: "user-1",
      mime: "application/pdf",
      randomId: "cert001",
      date: new Date("2026-08-14T00:00:00Z"),
    });
    expect(key).toBe("cert/user-1/20260814/cert001.pdf");
  });

  it("不同 randomId → 不同 key（随机唯一性）", () => {
    const base = {
      folder: "product",
      userId: "user-1",
      mime: "image/webp" as const,
      date: new Date("2026-08-14T00:00:00Z"),
    };
    const k1 = buildObjectKey({ ...base, randomId: "aaa" });
    const k2 = buildObjectKey({ ...base, randomId: "bbb" });
    expect(k1).not.toBe(k2);
  });
});

describe("isOssUrlForHosts — host 白名单判定", () => {
  const hosts = ["mybucket.oss-cn-hangzhou.aliyuncs.com", "img.example.com"];

  it("host ∈ 白名单 → true", () => {
    expect(
      isOssUrlForHosts("https://img.example.com/product/a.jpg", hosts),
    ).toBe(true);
    expect(
      isOssUrlForHosts("https://mybucket.oss-cn-hangzhou.aliyuncs.com/brand/a.png", hosts),
    ).toBe(true);
  });

  it("host ∉ 白名单 → false", () => {
    expect(
      isOssUrlForHosts("https://evil.com/x.jpg", hosts),
    ).toBe(false);
  });

  it("data URI / 相对路径 → false", () => {
    expect(isOssUrlForHosts("data:image/png;base64,AAAA", hosts)).toBe(false);
    expect(isOssUrlForHosts("/images/a.jpg", hosts)).toBe(false);
    expect(isOssUrlForHosts("", hosts)).toBe(false);
  });
});

describe("G4 — extractOssKeyFromUrl / isValidOssKeyStructure / isOssUrlOwnedBy", () => {
  // 同 getOssHostsFromEnv：bucket+region → mybucket.oss-cn-hangzhou.aliyuncs.com
  const env = {
    OSS_ACCESS_KEY_ID: "id",
    OSS_ACCESS_KEY_SECRET: "secret",
    OSS_BUCKET: "mybucket",
    OSS_REGION: "oss-cn-hangzhou",
  };
  const base = "https://mybucket.oss-cn-hangzhou.aliyuncs.com";

  describe("extractOssKeyFromUrl — 从 URL 提取对象 key", () => {
    it("本站 OSS URL → 返回 host 之后的 key 路径", () => {
      const prev = process.env;
      process.env = { ...env } as unknown as NodeJS.ProcessEnv;
      try {
        expect(extractOssKeyFromUrl(`${base}/product/user-1/20260814/a.jpg`)).toBe(
          "product/user-1/20260814/a.jpg",
        );
      } finally {
        process.env = prev;
      }
    });

    it("站外 host / 无路径 → null", () => {
      expect(extractOssKeyFromUrl("https://evil.com/product/a.jpg")).toBeNull();
      expect(extractOssKeyFromUrl(`${base}`)).toBeNull();
    });
  });

  describe("isValidOssKeyStructure — 上传 key 结构白名单", () => {
    it("标准 4 段 key（folder/userId/yyyymmdd/file.ext）→ true", () => {
      expect(isValidOssKeyStructure("product/user-1/20260814/a.jpg")).toBe(true);
      expect(isValidOssKeyStructure("cert/user-1/20260815/report.pdf")).toBe(true);
      expect(isValidOssKeyStructure("brand/user-9/20260101/logo.png")).toBe(true);
    });

    it("folder 非白名单 / 段数不足 / 日期非 8 位 / 无扩展名 → false", () => {
      expect(isValidOssKeyStructure("banner/user-1/20260814/a.jpg")).toBe(false);
      expect(isValidOssKeyStructure("product/user-1/a.jpg")).toBe(false);
      expect(isValidOssKeyStructure("product/user-1/2026081/a.jpg")).toBe(false);
      expect(isValidOssKeyStructure("product/user-1/20260814/noext")).toBe(false);
    });
  });

  describe("isOssUrlOwnedBy — key 归属当前用户", () => {
    it("key 的 userId 段 = 当前用户 → true", () => {
      const prev = process.env;
      process.env = { ...env } as unknown as NodeJS.ProcessEnv;
      try {
        expect(isOssUrlOwnedBy(`${base}/brand/user-1/20260814/logo.png`, "user-1")).toBe(true);
      } finally {
        process.env = prev;
      }
    });

    it("key 的 userId 段 = 他人 / 站外 URL / 非标准结构 → false", () => {
      const prev = process.env;
      process.env = { ...env } as unknown as NodeJS.ProcessEnv;
      try {
        expect(isOssUrlOwnedBy(`${base}/brand/user-other/20260814/logo.png`, "user-1")).toBe(false);
        expect(isOssUrlOwnedBy("https://evil.com/brand/user-1/20260814/logo.png", "user-1")).toBe(false);
        expect(isOssUrlOwnedBy(`${base}/brand/user-1/fake.png`, "user-1")).toBe(false);
      } finally {
        process.env = prev;
      }
    });
  });
});
