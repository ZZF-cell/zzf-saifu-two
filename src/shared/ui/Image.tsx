// 共享图片组件 — OSS URL + base64 双源（README 129 行要求）
// 统一各处的「暂无图片」占位图；只透传本项目用到的 next/image props 子集
"use client";

import NextImage from "next/image";
import { resolveImageSource } from "./image-source";

export interface SharedImageProps {
  src?: string | null;
  alt: string;
  className?: string;
  fill?: boolean;
  width?: number;
  height?: number;
  sizes?: string;
}

export function Image({
  src,
  alt,
  className,
  fill,
  width,
  height,
  sizes,
}: SharedImageProps) {
  const resolved = resolveImageSource(src);
  return (
    <NextImage
      src={resolved.src}
      alt={alt}
      className={className}
      fill={fill}
      width={width}
      height={height}
      sizes={sizes}
    />
  );
}

// 默认导出兼容现有 `import Image from "@/shared/ui/Image"` 用法（3 处组件）
export default Image;

export { PLACEHOLDER_IMAGE } from "./image-source";
