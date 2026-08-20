// 共享图片组件 — OSS URL + base64 双源（README 129 行要求）
// 统一各处的「暂无图片」占位图；只透传本项目用到的 next/image props 子集
"use client";

import { Component, type ReactNode } from "react";
import NextImage from "next/image";
import { resolveImageSource, PLACEHOLDER_IMAGE } from "./image-source";

export interface SharedImageProps {
  src?: string | null;
  alt: string;
  className?: string;
  fill?: boolean;
  width?: number;
  height?: number;
  sizes?: string;
}

/**
 * 图片渲染错误兜底边界：next/image 对不在 next.config remotePatterns 白名单的 https 源
 * 会在渲染期抛错（M15 fail-closed），脏数据/历史外链 URL 会白屏整页（质检中心已复现）。
 * 此边界只捕获图片子树抛错，回退占位图，其余正常渲染不受影响。
 */
class ImageRenderBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
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
    <ImageRenderBoundary
      // key=src：src 变化时重挂边界，重置 failed 状态——否则某 URL 渲染失败后
      // failed 恒为 true，用户换图/加载新 src 仍永远显示占位图
      key={resolved.src}
      fallback={
        <NextImage
          src={PLACEHOLDER_IMAGE}
          alt={alt}
          className={className}
          fill={fill}
          width={width}
          height={height}
          sizes={sizes}
        />
      }
    >
      <NextImage
        src={resolved.src}
        alt={alt}
        className={className}
        fill={fill}
        width={width}
        height={height}
        sizes={sizes}
      />
    </ImageRenderBoundary>
  );
}

// 默认导出兼容现有 `import Image from "@/shared/ui/Image"` 用法（3 处组件）
export default Image;

export { PLACEHOLDER_IMAGE } from "./image-source";
