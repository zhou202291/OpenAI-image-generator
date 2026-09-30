/* ============================================================
 *  类型定义
 * ============================================================ */

/** 生图模型预设 */
export interface ModelPreset {
  id: string
  label: string
  /** 该模型支持的画质选项 */
  qualities: string[]
  /** 该模型支持的尺寸选项 */
  sizes: string[]
  /** 是否支持 images/edits（改图 / 带参考图） */
  supportsEdit: boolean
  /** 是否支持 background 参数 */
  supportsBackground: boolean
  /** 是否支持 output_format / output_compression 参数 */
  supportsOutputFormat: boolean
  /** 是否支持 moderation 参数 */
  supportsModeration: boolean
  /** 是否支持 input_fidelity 参数 */
  supportsInputFidelity: boolean
  /** 是否支持 stream（流式返回中间帧） */
  supportsStream: boolean
  note?: string
}

/** 生成参数（会直接映射到 API 请求体） */
export interface GenParams {
  model: string
  /** 画质：low / medium / high / auto / hd / standard ... */
  quality: string
  /** 尺寸，如 1024x1024，或 auto，或自定义 WxH */
  size: string
  /** 一次生成几张 */
  n: number
  /** 背景：auto / transparent / opaque */
  background: string
  /** 输出格式：png / jpeg / webp */
  output_format: string
  /** 压缩率 0-100，仅 jpeg/webp 有效 */
  output_compression: number
  /** 内容审核：auto / low */
  moderation: string
  /** 输入保真度：high / low */
  input_fidelity: string
  /** 流式中间帧数量 0-3 */
  partial_images: number
  /** 是否使用流式生成 */
  stream: boolean
}

/** 会话里的一条消息 */
export interface Attachment {
  id: string
  /** data URL */
  dataUrl: string
  name: string
  width: number
  height: number
  bytes: number
}

export interface GenImage {
  id: string
  /**
   * 显示用的地址。
   * 落盘模式下是 /__file/<目录>/<文件名>（由本地服务从磁盘读取），
   * 未落盘时才退回 data URL。
   */
  dataUrl: string
  /** 落盘后的相对路径，如 20260929212100/20260929213512456_一只猫.png */
  relPath?: string
  /** 落盘后的完整磁盘路径，便于直接去文件夹里找 */
  fullPath?: string
  /** 磁盘上的字节数 */
  bytes?: number
  /** 模型改写过后的提示词（如果接口返回） */
  revisedPrompt?: string
  width?: number
  height?: number
  /** 生成这张图用的提示词，导出/落盘时要用 */
  prompt?: string
}

export interface Turn {
  id: string
  role: 'user' | 'assistant'
  /** 用户消息的文字 */
  text?: string
  /** 用户消息附带的参考图 */
  attachments?: Attachment[]
  /** 助手回复的图片 */
  images?: GenImage[]
  /** 出错信息 */
  error?: string
  /** 本次实际使用的参数快照 */
  usedParams?: GenParams
  /** 本次请求走的是 generation 还是 edit */
  endpoint?: 'generations' | 'edits'
  /** 耗时 ms */
  elapsedMs?: number
  /** token 用量 */
  usage?: { input: number; output: number; total: number }
  createdAt: number
}

export interface Session {
  id: string
  title: string
  turns: Turn[]
  createdAt: number
  updatedAt: number
  /**
   * 会话创建时刻的时间戳字符串，格式 20260929212100。
   * 用作图片在磁盘上的目录名，所以创建后就不再改变。
   */
  stamp: string
}

/** 连接配置 */
export interface ApiConfig {
  baseUrl: string
  apiKey: string
  /** 额外请求头，JSON 字符串 */
  extraHeaders: string
  /** 请求超时 ms */
  timeoutMs: number
  /** 已拉取到的可用模型列表 */
  availableModels: string[]
  /** 上次拉取模型列表的时间 */
  modelsFetchedAt?: number
}

export interface Settings {
  api: ApiConfig
  params: GenParams
  /** 历史图上限，防止 localStorage 撑爆 */
  maxSessions: number
}

/* ============================================================
 *  模型预设表
 * ============================================================ */

const GPT_IMAGE_BASE = {
  qualities: ['auto', 'low', 'medium', 'high'],
  sizes: ['auto', '1024x1024', '1536x1024', '1024x1536'],
  supportsEdit: true,
  supportsBackground: true,
  supportsOutputFormat: true,
  supportsModeration: true,
  supportsInputFidelity: true,
  supportsStream: true,
}

export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: 'gpt-image-1',
    label: 'gpt-image-1',
    ...GPT_IMAGE_BASE,
    note: '经典 GPT 生图模型，稳定通用',
  },
  {
    id: 'gpt-image-1-mini',
    label: 'gpt-image-1-mini',
    ...GPT_IMAGE_BASE,
    note: '轻量版，更便宜更快',
  },
  {
    id: 'gpt-image-1.5',
    label: 'gpt-image-1.5',
    ...GPT_IMAGE_BASE,
    note: '效果更好，推荐默认使用',
  },
  {
    id: 'gpt-image-2',
    label: 'gpt-image-2 ★推荐',
    ...GPT_IMAGE_BASE,
    supportsInputFidelity: false,
    sizes: ['auto', '1024x1024', '1536x1024', '1024x1536', '自定义'],
    note: '支持任意分辨率（宽高需为 16 的倍数）。实测可用性最好。',
  },
  {
    id: 'gpt-image-2.5-flare',
    label: 'gpt-image-2.5-flare',
    ...GPT_IMAGE_BASE,
    qualities: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'],
    sizes: ['auto', '1024x1024', '1536x1024', '1024x1536', '自定义'],
    supportsInputFidelity: false,
    note: '最新一代，支持透明背景与极高画质。实测可用。',
  },
  {
    id: 'gpt-image-2.5-sunburst',
    label: 'gpt-image-2.5-sunburst',
    ...GPT_IMAGE_BASE,
    qualities: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'],
    sizes: ['auto', '1024x1024', '1536x1024', '1024x1536', '自定义'],
    supportsInputFidelity: false,
    note: '最新一代，支持透明背景与极高画质。实测可用。',
  },
  {
    id: 'chatgpt-image-latest',
    label: 'chatgpt-image-latest',
    ...GPT_IMAGE_BASE,
    note: '跟随最新版本的别名',
  },
  {
    id: 'dall-e-3',
    label: 'dall-e-3',
    qualities: ['standard', 'hd'],
    sizes: ['1024x1024', '1792x1024', '1024x1792'],
    supportsEdit: false,
    supportsBackground: false,
    supportsOutputFormat: false,
    supportsModeration: false,
    supportsInputFidelity: false,
    supportsStream: false,
    note: '旧模型，不支持改图',
  },
  {
    id: 'dall-e-2',
    label: 'dall-e-2',
    qualities: ['standard'],
    sizes: ['256x256', '512x512', '1024x1024'],
    supportsEdit: true,
    supportsBackground: false,
    supportsOutputFormat: false,
    supportsModeration: false,
    supportsInputFidelity: false,
    supportsStream: false,
    note: '最旧模型，只能改方形 PNG',
  },
]

/** 查预设，未知模型按 GPT image 系列的能力处理（大多数中转站如此） */
export function presetOf(model: string): ModelPreset {
  const found = MODEL_PRESETS.find((m) => m.id === model)
  if (found) return found
  return { id: model, label: model, ...GPT_IMAGE_BASE }
}

/* ============================================================
 *  默认值
 * ============================================================ */

export const DEFAULT_PARAMS: GenParams = {
  // 默认选 gpt-image-2：实测多数中转站对它的账号供给最充足，
  // gpt-image-1 / 1.5 经常返回 503 "No available compatible accounts"。
  model: 'gpt-image-2',
  quality: 'auto',
  size: 'auto',
  n: 1,
  background: 'auto',
  output_format: 'png',
  output_compression: 100,
  moderation: 'auto',
  input_fidelity: 'low',
  partial_images: 0,
  stream: false,
}

export const DEFAULT_SETTINGS: Settings = {
  api: {
    // 默认留空，首次打开时在设置里填自己的地址。
    // 填到 /v1 为止即可，例如 https://api.openai.com/v1
    baseUrl: '',
    // 密钥绝不写进代码
    apiKey: '',
    extraHeaders: '',
    timeoutMs: 300000,
    availableModels: [],
  },
  params: DEFAULT_PARAMS,
  maxSessions: 40,
}

/* ============================================================
 *  尺寸辅助
 * ============================================================ */

export const SIZE_CHOICES: { value: string; label: string; w: number; h: number }[] = [
  { value: 'auto', label: '自动', w: 0, h: 0 },
  { value: '1024x1024', label: '方形 1:1 · 1024', w: 1024, h: 1024 },
  { value: '1536x1024', label: '横向 3:2 · 1536', w: 1536, h: 1024 },
  { value: '1024x1536', label: '竖向 2:3 · 1024', w: 1024, h: 1536 },
  { value: '1792x1024', label: '横向 7:4 · 1792', w: 1792, h: 1024 },
  { value: '1024x1792', label: '竖向 4:7 · 1024', w: 1024, h: 1792 },
  { value: '256x256', label: '小图 256', w: 256, h: 256 },
  { value: '512x512', label: '中图 512', w: 512, h: 512 },
  { value: '2048x2048', label: '方形 2K', w: 2048, h: 2048 },
  { value: '2560x1440', label: '横向 2K', w: 2560, h: 1440 },
  { value: '1440x2560', label: '竖向 2K', w: 1440, h: 2560 },
  { value: '3840x2160', label: '横向 4K', w: 3840, h: 2160 },
]

export const QUALITY_LABELS: Record<string, string> = {
  auto: '自动',
  low: '低（快 / 省）',
  medium: '中',
  high: '高（慢 / 贵）',
  standard: '标准',
  hd: '高清',
  xhigh: '极高',
  max: '最高',
}
