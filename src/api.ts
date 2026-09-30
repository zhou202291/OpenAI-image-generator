import type { ApiConfig, GenImage, GenParams, Attachment } from './types'
import { presetOf } from './types'

/* ============================================================
 *  CORS 中转
 *  ------------------------------------------------------------
 *  浏览器不允许网页直接请求未授权跨域的 API。很多中转站不返回
 *  Access-Control-Allow-Origin，于是必须在本地做一次转发。
 *  这里在启动时探测一次：如果本地转发服务在跑，就走它；
 *  否则退回直连（适用于官方 API 等本身允许跨域的地址）。
 * ============================================================ */

let proxyAvailable: boolean | null = null

export function proxyBase(): string {
  // 页面本身就是由本地服务提供的（多为一 http://127.0.0.1:8787）
  if (location.protocol.startsWith('http') && /^(127\.0\.0\.1|localhost)$/.test(location.hostname)) {
    return `${location.origin}/__proxy`
  }
  return 'http://127.0.0.1:8787/__proxy'
}

/** 启动时探测本地转发服务是否可用 */
export async function detectProxy(): Promise<boolean> {
  if (proxyAvailable !== null) return proxyAvailable
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 1500)
    const res = await fetch(`${proxyBase()}?ping=1`, { signal: ctrl.signal })
    clearTimeout(t)
    proxyAvailable = res.status !== 404
  } catch {
    proxyAvailable = false
  }
  return proxyAvailable
}

export function isProxyAvailable() {
  return proxyAvailable === true
}

/** 统一出口：需要时把真实地址塞进 X-Target-URL 头交给本地服务转发 */
function requestUrl(realUrl: string): { url: string; viaProxy: boolean } {
  if (proxyAvailable) return { url: proxyBase(), viaProxy: true }
  return { url: realUrl, viaProxy: false }
}

/** 组装最终要发的请求头 */
function finalHeaders(cfg: ApiConfig, realUrl: string, contentType?: string): Record<string, string> {
  const h = buildHeaders(cfg, contentType)
  if (proxyAvailable) h['X-Target-URL'] = realUrl
  return h
}

/* ============================================================
 *  URL / 请求头
 * ============================================================ */

/** 把用户填的 base_url 规范化，并拼上某个路径 */
export function joinUrl(baseUrl: string, path: string): string {
  let base = (baseUrl || '').trim()
  if (!base) throw new Error('请先在设置里填写 base_url')
  // 去掉结尾斜杠
  base = base.replace(/\/+$/, '')
  // 用户可能把完整端点也粘进来了，做个兜底纠正
  base = base.replace(/\/images\/(generations|edits)$/i, '')
  base = base.replace(/\/(chat\/completions|models)$/i, '')
  // 如果没写 /v1 且不是明显的带版本路径，自动补 /v1
  if (!/\/v\d+[a-z]*$/i.test(base) && !/\/openai\/deployments/i.test(base)) {
    // Azure 风格：https://xxx.openai.azure.com/openai/deployments/<model>
    if (/\.openai\.azure\.com$/i.test(base)) base += '/openai'
    else base += '/v1'
  }
  return base + path
}

function buildHeaders(cfg: ApiConfig, contentType?: string): Record<string, string> {
  const h: Record<string, string> = {}
  if (contentType) h['Content-Type'] = contentType
  if (cfg.apiKey) h['Authorization'] = `Bearer ${cfg.apiKey.trim()}`
  if (cfg.extraHeaders && cfg.extraHeaders.trim()) {
    try {
      const extra = JSON.parse(cfg.extraHeaders)
      for (const [k, v] of Object.entries(extra)) {
        if (typeof v === 'string') h[k] = v
      }
    } catch {
      // 用户填的 JSON 不合法时静默忽略，避免整个请求失败
    }
  }
  return h
}

/* ============================================================
 *  磁盘存储（通过本地服务写文件）
 * ============================================================ */

export interface SavedFile {
  /** 相对路径，用它拼出可显示的地址 */
  rel: string
  /** 完整磁盘路径，方便提示用户去哪找 */
  path: string
  bytes: number
}

/** 本地服务的根地址（与代理同一个服务） */
export function serviceOrigin(): string {
  if (location.protocol.startsWith('http') && /^(127\.0\.0\.1|localhost)$/.test(location.hostname)) {
    return location.origin
  }
  return 'http://127.0.0.1:8787'
}

/** 把相对路径转成可显示的图片地址 */
export function fileUrl(rel: string): string {
  return `${serviceOrigin()}/__file/${rel.split('/').map(encodeURIComponent).join('/')}`
}

/**
 * 把一张图保存到磁盘。
 * 目录 = 会话创建时间戳，文件名 = 生成时间戳_提示词前20字
 */
export async function saveImageToDisk(
  dataUrl: string,
  prompt: string,
  sessionStamp: string,
): Promise<SavedFile | null> {
  try {
    const res = await fetch(`${serviceOrigin()}/__save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl, prompt, sessionStamp }),
    })
    if (!res.ok) return null
    const j = await res.json()
    if (!j?.ok) return null
    return { rel: j.rel, path: j.path, bytes: j.bytes }
  } catch {
    // 没启动本地服务时保存不了，退回用 data URL 显示
    return null
  }
}

/* ============================================================
 *  运行时配置（图片保存位置）
 * ============================================================ */

export interface RuntimeConfig {
  /** 当前生效的绝对路径 */
  imageDir: string
  /** 相对项目目录的写法（若在项目内） */
  imageDirRelative: string
  /** 默认位置 */
  defaultDir: string
  /** 项目所在目录 */
  projectDir: string
  exists: boolean
}

export async function getConfig(): Promise<RuntimeConfig | null> {
  try {
    const res = await fetch(`${serviceOrigin()}/__config`)
    if (!res.ok) return null
    return (await res.json()) as RuntimeConfig
  } catch {
    return null
  }
}

export interface SetImageDirResult {
  ok: boolean
  error?: string
  imageDir?: string
  /** 搬迁过去的图片张数 */
  moved?: number
  /** 因同名而跳过的文件数 */
  skipped?: number
  /** 搬迁过程中的错误（位置已改，但老图没搬全） */
  moveError?: string | null
}

/**
 * 修改图片保存位置
 * move 默认 true：把老图片一起搬过去，保证历史对话的图不失效
 */
export async function setImageDir(dir: string, move = true): Promise<SetImageDirResult> {
  try {
    const res = await fetch(`${serviceOrigin()}/__config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageDir: dir, move }),
    })
    const j = await res.json().catch(() => null)
    if (!res.ok) return { ok: false, error: j?.error || `HTTP ${res.status}` }
    return {
      ok: true,
      imageDir: j?.imageDir,
      moved: j?.moved,
      skipped: j?.skipped,
      moveError: j?.moveError ?? null,
    }
  } catch (e: any) {
    return { ok: false, error: e?.message || '无法连接本地服务' }
  }
}

/** 在系统文件管理器里打开保存目录 */
export async function revealImageDir(): Promise<boolean> {
  return revealPath()
}

/**
 * 在文件管理器里定位到某张图片（打开所在文件夹并选中它）
 * rel 形如 <会话目录>/<文件名>
 */
export async function revealImageFile(rel: string): Promise<boolean> {
  if (!rel) return false
  return revealPath(rel)
}

async function revealPath(rel?: string): Promise<boolean> {
  try {
    const suffix = rel ? '/' + rel.split('/').map(encodeURIComponent).join('/') : ''
    const res = await fetch(`${serviceOrigin()}/__reveal${suffix}`)
    return res.ok
  } catch {
    return false
  }
}

/** 清空项目里的对话记录（不动图片） */
export async function clearAllSessions(): Promise<boolean> {
  try {
    const res = await fetch(`${serviceOrigin()}/__sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessions: [] }),
    })
    return res.ok
  } catch {
    return false
  }
}

/* ============================================================
 *  错误处理
 * ============================================================ */

export class ApiError extends Error {
  status: number
  detail: string
  hint: string

  constructor(status: number, detail: string, hint: string) {
    super(detail)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
    this.hint = hint
  }
}

function explain(status: number, body: string): string {
  const b = (body || '').toLowerCase()
  if (status === 401 || status === 403) {
    return '鉴权失败。请检查 API Key 是否正确、是否有该模型的权限、base_url 是否填成了带 /v1 的正确地址。'
  }
  if (status === 404) {
    return '接口地址不存在。多数情况是 base_url 写错了 —— 正确写法应形如 https://xxx.com/v1 （末尾带 /v1），程序会自动拼接 /images/generations。'
  }
  if (status === 429) {
    return '被限流或余额不足。稍后重试，或检查账户额度。'
  }
  if (status === 400) {
    if (b.includes('unknown parameter') || b.includes('unexpected') || b.includes('not supported')) {
      return '接口不认识某个参数。请把右侧「高级参数」里的项改回默认值（尤其 background / output_format / moderation / input_fidelity / partial_images），有些中转站不支持这些参数。'
    }
    if (b.includes('size')) {
      return '尺寸不被该模型支持。请换回 1024x1024 / 1536x1024 / 1024x1536 或 auto。'
    }
    if (b.includes('model')) {
      return '模型名不被该接口支持。请点「拉取模型列表」看看账户实际能用哪些模型。'
    }
    if (b.includes('moderation') || b.includes('safety') || b.includes('content_policy')) {
      return '提示词被内容审核拦截，请换一种表述。'
    }
    return '请求被拒绝，多半是某个参数该模型不支持 —— 可先把高级参数全部恢复默认再试。'
  }
  if (status === 0) {
    return (
      '请求没能发出。常见原因是【浏览器跨域 CORS 限制】：该接口没有返回允许跨域的响应头。' +
      (isProxyAvailable()
        ? '本地转发服务已在运行，请检查网络或稍后重试。'
        : '解决办法：关闭本页，改用「启动.bat」打开（它会同时启动本地转发服务），即可绕过该限制。')
    )
  }
  if (status >= 500) {
    return '上游服务出错，通常稍后重试即可。'
  }
  return ''
}

async function parseError(res: Response): Promise<ApiError> {
  let text = ''
  try {
    text = await res.text()
  } catch {
    /* ignore */
  }
  let detail = text
  try {
    const j = JSON.parse(text)
    detail = j?.error?.message || j?.message || j?.error || text
    if (typeof detail !== 'string') detail = JSON.stringify(detail)
  } catch {
    /* 保持原始文本 */
  }
  if (!detail) detail = `HTTP ${res.status}`
  return new ApiError(res.status, detail.slice(0, 1200), explain(res.status, text))
}

/* ============================================================
 *  图片工具
 * ============================================================ */

export function guessMime(format: string): string {
  if (format === 'jpeg' || format === 'jpg') return 'image/jpeg'
  if (format === 'webp') return 'image/webp'
  return 'image/png'
}

/** 把接口返回的一条 image 对象转成 data URL 或远程 URL */
function toImageSrc(item: any, format: string): string | null {
  if (!item) return null
  if (typeof item === 'string') {
    if (item.startsWith('data:') || /^https?:\/\//i.test(item)) return item
    return `data:${guessMime(format)};base64,${item}`
  }
  if (item.b64_json) {
    const raw = String(item.b64_json)
    if (raw.startsWith('data:')) return raw
    return `data:${guessMime(format)};base64,${raw}`
  }
  if (item.url) return String(item.url)
  if (item.image_url) return String(item.image_url)
  if (item.image) return toImageSrc(item.image, format)
  return null
}

/** 从任意形状的响应里把图片抠出来 —— 兼容各种中转站的返回格式差异 */
export function extractImages(json: any, format: string): { src: string; revised?: string }[] {
  const out: { src: string; revised?: string }[] = []
  const push = (item: any) => {
    const src = toImageSrc(item, format)
    if (src) out.push({ src, revised: item?.revised_prompt })
  }

  if (!json) return out

  // 标准格式：{ data: [ {b64_json|url} ] }
  if (Array.isArray(json.data)) json.data.forEach(push)
  // 有些中转站：{ images: [ ... ] } 或 { output: [ ... ] }
  if (Array.isArray(json.images)) json.images.forEach(push)
  if (Array.isArray(json.output)) json.output.forEach(push)
  // Gemini 风格：{ candidates: [ { content: { parts: [ { inlineData: { data } } ] } } ] }
  if (Array.isArray(json.candidates)) {
    for (const c of json.candidates) {
      const parts = c?.content?.parts
      if (Array.isArray(parts)) {
        for (const p of parts) {
          const d = p?.inlineData?.data || p?.inline_data?.data
          if (d) out.push({ src: `data:${p?.inlineData?.mimeType || p?.inline_data?.mime_type || 'image/png'};base64,${d}` })
          else if (p?.image_url?.url) out.push({ src: p.image_url.url })
        }
      }
    }
  }
  // 单条包裹：{ data: { b64_json } } 或顶层直接就是图片对象
  if (!Array.isArray(json.data) && json.data) push(json.data)
  if (out.length === 0) {
    push(json)
    if (json?.result) push(json.result)
  }

  // 去重
  const seen = new Set<string>()
  return out.filter((o) => {
    if (seen.has(o.src)) return false
    seen.add(o.src)
    return true
  })
}

/** URL 形式的图片抓成本地 data URL，避免链接 60 分钟失效 */
async function urlToDataUrl(url: string, timeoutMs: number): Promise<string> {
  if (url.startsWith('data:')) return url
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    let res: Response
    try {
      res = await fetch(url, { signal: ctrl.signal })
    } catch (e) {
      // 图片域名跨域失败时，改走本地转发
      if (proxyAvailable) {
        res = await fetch(proxyBase(), { signal: ctrl.signal, headers: { 'X-Target-URL': url } })
      } else {
        throw e
      }
    }
    if (!res.ok) throw new Error(`下载图片失败 HTTP ${res.status}`)
    const blob = await res.blob()
    return await blobToDataUrl(blob)
  } finally {
    clearTimeout(t)
  }
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result))
    fr.onerror = () => reject(new Error('读取图片失败'))
    fr.readAsDataURL(blob)
  })
}

/** 读取图片真实宽高 */
export function measureImage(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => resolve({ width: 0, height: 0 })
    img.src = src
  })
}

/** 判断图片是否带透明通道（用于提示 background=transparent 是否生效） */
export function hasAlpha(src: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      try {
        const c = document.createElement('canvas')
        c.width = Math.min(img.naturalWidth, 256)
        c.height = Math.min(img.naturalHeight, 256)
        const ctx = c.getContext('2d')
        if (!ctx) return resolve(false)
        ctx.drawImage(img, 0, 0, c.width, c.height)
        const d = ctx.getImageData(0, 0, c.width, c.height).data
        for (let i = 3; i < d.length; i += 4) {
          if (d[i] < 250) return resolve(true)
        }
        resolve(false)
      } catch {
        resolve(false)
      }
    }
    img.onerror = () => resolve(false)
    img.src = src
  })
}

/* ============================================================
 *  请求体构造
 * ============================================================ */

/** 只把当前模型真正支持的参数塞进请求体，减少中转站 400 的概率 */
export function buildBody(p: GenParams, prompt: string): Record<string, any> {
  const preset = presetOf(p.model)
  const body: Record<string, any> = {
    model: p.model,
    prompt,
    n: Math.max(1, Math.min(10, Number(p.n) || 1)),
  }

  if (p.size && p.size !== 'auto') body.size = p.size
  else if (p.size === 'auto') body.size = 'auto'

  if (p.quality && p.quality !== 'auto') body.quality = p.quality
  else if (p.quality === 'auto') body.quality = 'auto'

  if (preset.supportsBackground && p.background && p.background !== 'auto') {
    body.background = p.background
  }
  if (preset.supportsOutputFormat) {
    if (p.output_format && p.output_format !== 'png') body.output_format = p.output_format
    if ((p.output_format === 'jpeg' || p.output_format === 'webp') && p.output_compression < 100) {
      body.output_compression = Math.max(0, Math.min(100, Number(p.output_compression) || 100))
    }
  }
  if (preset.supportsModeration && p.moderation === 'low') {
    body.moderation = 'low'
  }
  if (p.stream && preset.supportsStream) {
    body.stream = true
    if (p.partial_images > 0) body.partial_images = Math.max(0, Math.min(3, Number(p.partial_images)))
  }
  return body
}

/** 背景透明时必须用 png/webp，这里做个自动纠正 */
export function normalizeParams(p: GenParams): GenParams {
  const out = { ...p }
  if (out.background === 'transparent' && out.output_format === 'jpeg') {
    out.output_format = 'png'
  }
  if (out.output_format === 'png') out.output_compression = 100
  return out
}

/* ============================================================
 *  流式响应解析（SSE）
 * ============================================================ */

interface StreamHandlers {
  /** 收到一张中间帧（低清预览） */
  onPartial?: (dataUrl: string, index: number) => void
  onStatus?: (text: string) => void
}

/** 解析 text/event-stream，把中间帧和最终图都取出来 */
async function readImageStream(
  res: Response,
  format: string,
  handlers: StreamHandlers,
): Promise<{ src: string; revised?: string }[]> {
  const reader = res.body?.getReader()
  if (!reader) throw new Error('流式响应不可读')
  const decoder = new TextDecoder()
  let buf = ''
  const results: { src: string; revised?: string }[] = []

  const consume = (eventName: string, data: string) => {
    if (data === '[DONE]') return
    let json: any
    try {
      json = JSON.parse(data)
    } catch {
      return
    }
    const type = json?.type || eventName

    if (type === 'image_generation.partial_image' || json?.partial_image_index !== undefined) {
      const b64 = json?.b64_json || json?.data
      if (b64) {
        const src = String(b64).startsWith('data:') ? String(b64) : `data:${guessMime(format)};base64,${b64}`
        handlers.onPartial?.(src, Number(json?.partial_image_index ?? 0))
      }
      return
    }
    if (type === 'image_generation.completed' || type === 'image_generation.done') {
      const found = extractImages(json, format)
      found.forEach((f) => results.push(f))
      return
    }
    // 有些中转站直接在 data 里给完整响应
    const found = extractImages(json, format)
    found.forEach((f) => results.push(f))
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    // SSE 事件之间用空行分隔
    let sep: RegExpMatchArray | null
    while ((sep = buf.match(/\r?\n\r?\n/)) !== null && sep.index !== undefined) {
      const raw = buf.slice(0, sep.index)
      buf = buf.slice(sep.index + sep[0].length)
      let eventName = ''
      const dataLines: string[] = []
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
      }
      if (dataLines.length) consume(eventName, dataLines.join('\n'))
    }
    // 防止异常服务端把缓冲区撑爆
    if (buf.length > 4_000_000) buf = buf.slice(-100_000)
  }
  if (buf.trim()) {
    for (const line of buf.split(/\r?\n/)) {
      const l = line.trim()
      if (l.startsWith('data:')) consume('', l.slice(5).trim())
    }
  }
  return results
}

/* ============================================================
 *  主调用
 * ============================================================ */

export interface GenerateResult {
  images: GenImage[]
  endpoint: 'generations' | 'edits'
  elapsedMs: number
  usage?: { input: number; output: number; total: number }
}

/** 生成 / 改图。带参考图则走 edits，否则走 generations */
export async function generateImage(
  cfg: ApiConfig,
  params: GenParams,
  prompt: string,
  attachments: Attachment[],
  /** 会话创建时间戳（20260929212100），作为磁盘上的目录名 */
  sessionStamp: string,
  handlers: StreamHandlers = {},
): Promise<GenerateResult> {
  const p = normalizeParams(params)
  const useEdit = attachments.length > 0
  const path = useEdit ? '/images/edits' : '/images/generations'
  const realUrl = joinUrl(cfg.baseUrl, path)
  const { url } = requestUrl(realUrl)

  const ctrl = new AbortController()
  const timeout = Math.max(10000, cfg.timeoutMs || 300000)
  const timer = setTimeout(() => ctrl.abort(), timeout)

  const started = performance.now()
  let res: Response
  try {
    if (useEdit) {
      const fd = new FormData()
      const body = buildBody(p, prompt)
      for (const [k, v] of Object.entries(body)) fd.append(k, String(v))
      // 官方支持 image 传数组，多图一起提交
      for (const a of attachments) {
        const blob = await (await fetch(a.dataUrl)).blob()
        const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg')
        fd.append('image', blob, a.name || `ref.${ext}`)
      }
      handlers.onStatus?.('正在上传参考图…')
      // 注意：走转发时不要手写 Content-Type，必须让浏览器自己带 multipart 边界
      res = await fetch(url, { method: 'POST', headers: finalHeaders(cfg, realUrl), body: fd, signal: ctrl.signal })
    } else {
      const body = buildBody(p, prompt)
      res = await fetch(url, {
        method: 'POST',
        headers: finalHeaders(cfg, realUrl, 'application/json'),
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
    }
  } catch (e: any) {
    clearTimeout(timer)
    const isAbort = e?.name === 'AbortError'
    if (isAbort) {
      throw new ApiError(0, `请求超时（超过 ${Math.round(timeout / 1000)} 秒）`, '生图较慢时可以调高设置里的超时时间；也可能是网络中断。')
    }
    throw new ApiError(0, e?.message || '请求发送失败', explain(0, ''))
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) throw await parseError(res)

  const ctype = res.headers.get('content-type') || ''
  let items: { src: string; revised?: string }[] = []
  let usage: GenerateResult['usage']

  if (ctype.includes('text/event-stream')) {
    handlers.onStatus?.('模型正在绘制…')
    items = await readImageStream(res, p.output_format, handlers)
  } else {
    const text = await res.text()
    let json: any
    try {
      json = JSON.parse(text)
    } catch {
      // 有些中转站直接返回图片二进制
      if (ctype.startsWith('image/')) {
        const blob = new Blob([text], { type: ctype })
        items = [{ src: await blobToDataUrl(blob) }]
      } else {
        throw new ApiError(
          res.status,
          text.slice(0, 500) || '返回内容无法解析',
          '返回的不是标准 JSON。若这是 200 响应，说明该中转站接口格式与 OpenAI 不同，可能需要在设置里更换 base_url。',
        )
      }
    }
    if (json) {
      items = extractImages(json, p.output_format)
      if (json?.usage) {
        usage = {
          input: json.usage.input_tokens ?? 0,
          output: json.usage.output_tokens ?? 0,
          total: json.usage.total_tokens ?? 0,
        }
      }
      if (json?.error) {
        const msg = typeof json.error === 'string' ? json.error : json.error?.message || '接口返回了错误'
        throw new ApiError(200, msg, '')
      }
    }
  }

  if (items.length === 0) {
    throw new ApiError(
      200,
      '接口调用成功，但返回里没有找到图片数据',
      '该中转站可能返回了非标准结构，或图片字段名不同。可以先看浏览器控制台的原始返回，再告诉我格式，我来适配。',
    )
  }

  handlers.onStatus?.('正在保存图片…')
  const images: GenImage[] = []
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    let src = it.src
    if (/^https?:\/\//i.test(src)) {
      try {
        src = await urlToDataUrl(src, 120000)
      } catch {
        // 下载失败就退回用远程 URL 显示
      }
    }
    const dim = await measureImage(src)

    // 关键：把图片写到磁盘，浏览器里只留一条轻量引用。
    // 这样 localStorage 不会再被 base64 撑爆，会话也就不会丢。
    let displaySrc = src
    let saved: SavedFile | null = null
    if (src.startsWith('data:')) {
      saved = await saveImageToDisk(src, prompt, sessionStamp)
      if (saved) displaySrc = fileUrl(saved.rel)
    }

    images.push({
      id: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`,
      dataUrl: displaySrc,
      relPath: saved?.rel,
      fullPath: saved?.path,
      bytes: saved?.bytes,
      revisedPrompt: it.revised,
      width: dim.width,
      height: dim.height,
      prompt,
    })
  }

  return { images, endpoint: useEdit ? 'edits' : 'generations', elapsedMs: performance.now() - started, usage }
}

/* ============================================================
 *  拉取模型列表
 * ============================================================ */

export async function fetchModels(cfg: ApiConfig): Promise<string[]> {
  const realUrl = joinUrl(cfg.baseUrl, '/models')
  const { url } = requestUrl(realUrl)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), Math.min(60000, cfg.timeoutMs || 30000))
  let res: Response
  try {
    res = await fetch(url, { method: 'GET', headers: finalHeaders(cfg, realUrl), signal: ctrl.signal })
  } catch (e: any) {
    clearTimeout(timer)
    throw new ApiError(0, e?.message || '无法连接', explain(0, ''))
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) throw await parseError(res)
  const json: any = await res.json().catch(() => null)
  const list: string[] = []
  const arr = json?.data || json?.models || json
  if (Array.isArray(arr)) {
    for (const m of arr) {
      const id = typeof m === 'string' ? m : m?.id || m?.name
      if (id) list.push(String(id))
    }
  }
  // 把疑似生图模型排前面
  list.sort((a, b) => {
    const score = (s: string) => (/image/i.test(s) ? 0 : /dall-e/i.test(s) ? 1 : 2)
    return score(a) - score(b) || a.localeCompare(b)
  })
  return list
}

/* ============================================================
 *  连通性自检
 * ============================================================ */

export interface ProbeResult {
  ok: boolean
  title: string
  detail: string
}

/** 只做一次最小成本的检查：GET /models */
export async function probe(cfg: ApiConfig): Promise<ProbeResult> {
  if (!cfg.baseUrl.trim()) return { ok: false, title: '还没填 base_url', detail: '请填写形如 https://xxx.com/v1 的地址。' }
  if (!cfg.apiKey.trim()) return { ok: false, title: '还没填 API Key', detail: '请填写以 sk- 开头的密钥。' }
  await detectProxy()
  try {
    const models = await fetchModels(cfg)
    const via = isProxyAvailable() ? '（经本地转发）' : '（浏览器直连）'
    return {
      ok: true,
      title: `连接正常${via}，可见 ${models.length} 个模型`,
      detail: models.slice(0, 6).join('、') + (models.length > 6 ? ' …' : ''),
    }
  } catch (e: any) {
    const err = e as ApiError
    return {
      ok: false,
      title: `连接失败：${err.detail || err.message}`,
      detail: err.hint || '请检查 base_url 与 API Key。',
    }
  }
}
