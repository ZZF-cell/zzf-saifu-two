// 实名认证适配器（占位骨架）— 身份证二要素（姓名 + 身份证号）验证
//
// 现状（README 功能矩阵「实名认证」⏳ 待开发）：真实服务商未接入。
// 策略：定义 RealNameAdapter 接口，占位阶段提供演示 provider（REALNAME_MOCK=true），
// 未来接入真实服务商（阿里云/腾讯云实人认证等）时实现同一接口替换，调用方无需改动。
//
// 环境变量：
//   REALNAME_MOCK — "true" 时启用演示 provider（本地联调 / 单元测试；不做真实实名核验）
//   未配置 → 安全降级拒绝（success:false），与支付适配器未配置降级一致：
//   实名核验宁可不做也不伪造通过，避免把「未核验」误当「已核验」放行。

export interface VerifyIdentityParams {
  /** 真实姓名（与身份证一致） */
  realName: string;
  /** 身份证号（18 位，末位可为 X） */
  idNumber: string;
}

export interface VerifyIdentityResult {
  /** 请求是否被成功受理（未配置/参数异常为 false） */
  success: boolean;
  /** 二要素是否匹配（仅 provider 判定；受理失败时为 undefined） */
  matched?: boolean;
  /** 业务提示（如「实名信息核验通过」/「身份证号格式不正确」） */
  message?: string;
  error?: string;
}

export interface RealNameAdapter {
  verifyIdentity(params: VerifyIdentityParams): Promise<VerifyIdentityResult>;
}

// ── 身份证号格式校验（本地前置校验，不依赖服务商） ──
// 18 位：前 17 位数字 + 末位数字或大写 X（小写 x 归一化）
const ID_CARD_RE = /^\d{17}[\dXx]$/;

/** 身份证号基本格式校验（占位阶段本地能做的前置校验；接入服务商后仍保留作为客户端预判） */
export function isValidIdNumber(idNumber: string): boolean {
  return ID_CARD_RE.test(idNumber.trim());
}

// ── 演示 provider（占位） ──
// 真实二要素一致性（姓名与证件号是否匹配）必须由服务商核验，本地无法判定。
// 演示模式仅做格式预检 + 合法即假定通过，供联调/测试走通「受理 → 结果」链路。

function createMockRealNameAdapter(): RealNameAdapter {
  return {
    async verifyIdentity({ realName, idNumber }) {
      const name = realName.trim();
      if (!name) {
        return { success: false, error: "姓名不能为空" };
      }
      if (!isValidIdNumber(idNumber)) {
        return { success: false, message: "身份证号格式不正确", matched: false };
      }
      return {
        success: true,
        matched: true,
        message: "演示模式：实名信息核验通过（未接入真实服务商）",
      };
    },
  };
}

// ── 未配置降级（safe default：不配置不核验，一律拒绝） ──

function createUnavailableRealNameAdapter(reason: string): RealNameAdapter {
  return {
    async verifyIdentity() {
      return { success: false, error: reason };
    },
  };
}

// ── 模块级单例（一次判定；测试用 vi.resetModules() + 动态 import 重建） ──
// 与支付适配器一致：模块加载阶段不抛错，降级信息随结果返回。

let cachedAdapter: RealNameAdapter | null = null;

export function getRealNameAdapter(): RealNameAdapter {
  if (cachedAdapter) return cachedAdapter;
  cachedAdapter =
    process.env.REALNAME_MOCK === "true"
      ? createMockRealNameAdapter()
      : createUnavailableRealNameAdapter(
          "实名认证未配置，缺少环境变量 REALNAME_MOCK=true（占位阶段仅支持演示模式）",
        );
  return cachedAdapter;
}

/** 单例：功能模块通过 Public API 依赖此适配器，接入真实服务商时只替换内部实现 */
export const realNameAdapter = getRealNameAdapter();
