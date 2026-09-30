/**
 * 本地服务（静态托管 + CORS 转发 + 图片落盘）
 * ------------------------------------------------------------
 * 1. 静态托管 dist/ 里的页面
 * 2. /__proxy        转发请求，绕过浏览器跨域限制
 * 3. /__save         把生成的图片按「对话时间」归档到磁盘
 * 4. /__file/...     把磁盘上的图片读回来给页面显示
 * 5. /__list         列出磁盘上已有的会话目录
 *
 * 启动：  node server.mjs
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(__dirname, 'dist')

/* ---------- 端口 ---------- */
const BASE_PORT = Number(process.env.PORT || 8787)
let PORT = BASE_PORT

/* ============================================================
 *  目录布局
 *  ------------------------------------------------------------
 *  全部放在项目目录内，整个文件夹拷到任何机器都能直接用：
 *
 *    <项目>/image/           生成的图片（按对话时间分文件夹）
 *    <项目>/data/sessions.json   对话记录
 *    <项目>/.config.json     运行时配置（保存位置等）
 *
 *  保存位置可以在界面里改；改成项目外的绝对路径也可以。
 * ============================================================ */

const CONFIG_FILE = path.join(__dirname, '.config.json')
const DATA_DIR = path.join(__dirname, 'data')
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json')
const DEFAULT_IMAGE_DIR = './image'

/** 把可能是相对路径的 dir 解析成绝对路径（相对项目目录） */
function resolveImageDir(dir) {
  const d = String(dir || '').trim() || DEFAULT_IMAGE_DIR
  return path.isAbsolute(d) ? path.normalize(d) : path.resolve(__dirname, d)
}

let IMAGE_ROOT = resolveImageDir(process.env.IMAGE_DIR || DEFAULT_IMAGE_DIR)

/** 读取持久化的配置（界面里改过的保存位置） */
function loadConfig() {
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    if (j && typeof j.imageDir === 'string' && j.imageDir.trim()) {
      IMAGE_ROOT = resolveImageDir(j.imageDir)
    }
  } catch {
    /* 没有配置文件就用默认值 */
  }
}

/** 保存配置 */
function saveConfig() {
  try {
    // 在项目内就存相对路径，便于整个文件夹搬移
    const rel = path.relative(__dirname, IMAGE_ROOT)
    const isInside = rel && !rel.startsWith('..') && !path.isAbsolute(rel)
    const toStore = isInside ? './' + rel.split(path.sep).join('/') : IMAGE_ROOT
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ imageDir: toStore }, null, 2), 'utf8')
  } catch {
    /* 写不进去也不影响本次运行 */
  }
}

loadConfig()

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
}

function json(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(JSON.stringify(obj))
}

/* ============================================================
 *  文件名安全化
 * ============================================================ */

/** 去掉 Windows 文件名非法字符，并限制长度 */
function safeName(s, maxLen = 40) {
  let out = String(s || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  out = out.replace(/[. ]+$/, '') // Windows 不允许结尾的点和空格
  if (out.length > maxLen) out = out.slice(0, maxLen)
  return out || 'untitled'
}

/** 20260929212100 —— 年月日时分秒 */
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
}

/* ============================================================
 *  保存图片到磁盘
 *  <IMAGE_ROOT>/<会话创建时间>/<生成时间到毫秒>_<提示词前30字>.<ext>
 *  同一毫秒内的多张图会追加 -1 -2 序号，避免重名覆盖
 * ============================================================ */

async function handleSave(req, res) {
  let raw = ''
  for await (const c of req) raw += c

  let body
  try {
    body = JSON.parse(raw)
  } catch {
    json(res, 400, { error: '请求体不是合法 JSON' })
    return
  }

  const { dataUrl, prompt, sessionStamp } = body || {}
  if (!dataUrl || typeof dataUrl !== 'string') {
    json(res, 400, { error: '缺少 dataUrl' })
    return
  }

  const m = /^data:(image\/[a-z+.-]+);base64,([\s\S]+)$/i.exec(dataUrl.trim())
  if (!m) {
    json(res, 400, { error: 'dataUrl 格式不正确（需要 data:image/...;base64,...）' })
    return
  }
  const mime = m[1].toLowerCase()
  const ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png'

  let buf
  try {
    buf = Buffer.from(m[2].replace(/\s/g, ''), 'base64')
  } catch {
    json(res, 400, { error: 'base64 解码失败' })
    return
  }
  if (!buf.length) {
    json(res, 400, { error: '图片数据为空' })
    return
  }

  // 目录名 = 对话创建时间；缺失则用当前时间
  const dirName = safeName(String(sessionStamp || '').replace(/\D/g, '') || stamp(), 14)

  // 文件名 = 生成时间(精确到毫秒) + 提示词前 30 个字
  const now = new Date()
  const timePart = stamp(now) + String(now.getMilliseconds()).padStart(3, '0')
  // Array.from 按「字」切分，中文/emoji 都不会切坏
  const chars = Array.from(String(prompt || '').trim())
  const promptPart = safeName(chars.slice(0, 30).join(''), 30)

  const dir = path.join(IMAGE_ROOT, dirName)
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (e) {
    json(res, 500, { error: `无法创建目录 ${dir}: ${e.message}` })
    return
  }

  // 同一毫秒内保存多张图时，时间戳会完全一样，所以再加一段随机串：
  //   时间戳(到毫秒) + 4位随机 + 提示词前30字
  // 时间戳保证按文件名排序 ≈ 生成顺序，随机串保证绝不重名。
  // 极端巧合下仍撞名，就重新摇一次（最多 50 次）。
  let fileName = ''
  let full = ''
  for (let attempt = 0; attempt < 50; attempt++) {
    const rand = String(Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0'))
    fileName = `${timePart}_${rand}_${promptPart}.${ext}`
    full = path.join(dir, fileName)
    if (!fs.existsSync(full)) break
  }

  try {
    fs.writeFileSync(full, buf)
  } catch (e) {
    json(res, 500, { error: `写入失败: ${e.message}` })
    return
  }

  json(res, 200, { ok: true, rel: `${dirName}/${fileName}`, dir: dirName, file: fileName, bytes: buf.length, path: full })
}

/* ============================================================
 *  读取磁盘上的图片  GET /__file/<dir>/<file>
 * ============================================================ */

function handleFile(req, res) {
  // 先按 URL 解码再判断，防止 %2e%2e 这类编码绕过
  let rel
  try {
    rel = decodeURIComponent((req.url || '').replace(/^\/__file\//, '').split('?')[0])
  } catch {
    json(res, 400, { error: '路径编码不合法' })
    return
  }

  // 归一化并强制校验：结果必须严格位于 IMAGE_ROOT 之内
  const root = path.resolve(IMAGE_ROOT)
  const full = path.resolve(root, rel)
  if (full !== root && !full.startsWith(root + path.sep)) {
    json(res, 403, { error: '非法路径' })
    return
  }
  // 只允许读取图片扩展名，杜绝任何形式的意外文件暴露
  if (!/\.(png|jpe?g|webp)$/i.test(full)) {
    json(res, 403, { error: '只允许读取图片文件' })
    return
  }

  fs.readFile(full, (err, buf) => {
    if (err) {
      json(res, 404, { error: `找不到图片: ${rel}` })
      return
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*',
    })
    res.end(buf)
  })
}

/* ============================================================
 *  列出磁盘上已有的会话目录  GET /__list
 * ============================================================ */

function handleList(req, res) {
  try {
    if (!fs.existsSync(IMAGE_ROOT)) {
      json(res, 200, { root: IMAGE_ROOT, sessions: [] })
      return
    }
    const dirs = fs
      .readdirSync(IMAGE_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse()
      .slice(0, 300)
    const sessions = dirs.map((dir) => {
      let files = []
      try {
        files = fs.readdirSync(path.join(IMAGE_ROOT, dir)).filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
      } catch {}
      return { dir, count: files.length, files: files.slice(0, 500) }
    })
    json(res, 200, { root: IMAGE_ROOT, sessions })
  } catch (e) {
    json(res, 500, { error: e.message })
  }
}

/* ============================================================
 *  对话记录读写  GET/POST /__sessions
 *  ------------------------------------------------------------
 *  存到 <项目>/data/sessions.json，这样拷走整个项目时
 *  对话记录也跟着走，不依赖浏览器。
 * ============================================================ */

const MAX_SESSIONS_BYTES = 64 * 1024 * 1024 // 单个文件上限 64MB

function handleGetSessions(req, res) {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) {
      json(res, 200, { sessions: [] })
      return
    }
    const raw = fs.readFileSync(SESSIONS_FILE, 'utf8')
    const j = JSON.parse(raw)
    json(res, 200, { sessions: Array.isArray(j?.sessions) ? j.sessions : [] })
  } catch (e) {
    // 文件损坏时不要让前端白屏，返回空并提示
    json(res, 200, { sessions: [], warning: `对话记录读取失败：${e.message}` })
  }
}

async function handleSetSessions(req, res) {
  let raw = ''
  let tooBig = false
  for await (const c of req) {
    raw += c
    if (raw.length > MAX_SESSIONS_BYTES) {
      tooBig = true
      break
    }
  }
  if (tooBig) {
    json(res, 413, { error: '对话记录过大（超过 64MB），请先清理旧会话' })
    return
  }

  let body
  try {
    body = JSON.parse(raw)
  } catch {
    json(res, 400, { error: '请求体不是合法 JSON' })
    return
  }

  const sessions = body?.sessions
  if (!Array.isArray(sessions)) {
    json(res, 400, { error: 'sessions 必须是数组' })
    return
  }

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    // 先写临时文件再改名，避免写一半崩溃把原文件毁掉
    const tmp = SESSIONS_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ sessions, savedAt: Date.now() }, null, 2), 'utf8')
    fs.renameSync(tmp, SESSIONS_FILE)
    json(res, 200, { ok: true, count: sessions.length })
  } catch (e) {
    json(res, 500, { error: `保存失败：${e.message}` })
  }
}

/* ============================================================
 *  配置读写  GET/POST /__config
 *  前端在「设置」里修改图片保存位置时用
 * ============================================================ */

function handleGetConfig(req, res) {
  json(res, 200, {
    // 当前生效的绝对路径
    imageDir: IMAGE_ROOT,
    // 相对于项目目录的写法（如果就在项目内）
    imageDirRelative: (() => {
      const rel = path.relative(__dirname, IMAGE_ROOT)
      return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? './' + rel.split(path.sep).join('/') : IMAGE_ROOT
    })(),
    defaultDir: resolveImageDir(DEFAULT_IMAGE_DIR),
    projectDir: __dirname,
    exists: fs.existsSync(IMAGE_ROOT),
  })
}

async function handleSetConfig(req, res) {
  let raw = ''
  for await (const c of req) raw += c

  let body
  try {
    body = JSON.parse(raw)
  } catch {
    json(res, 400, { error: '请求体不是合法 JSON' })
    return
  }

  const dir = String(body?.imageDir || '').trim()
  if (!dir) {
    json(res, 400, { error: '请填写保存位置' })
    return
  }
  /** 是否把老图片一起搬过去（默认搬，像 QQ 换存储位置那样） */
  const shouldMove = body?.move !== false

  const next = resolveImageDir(dir)
  if (next.length < 4) {
    json(res, 400, { error: '路径太短，请填写完整目录' })
    return
  }
  // 不允许嵌套：否则搬迁时可能把自己拷进自己里面
  const prev = path.resolve(IMAGE_ROOT)
  if (next === prev) {
    json(res, 400, { error: '新位置和当前位置相同，无需修改' })
    return
  }
  const nested =
    (next.startsWith(prev + path.sep)) || (prev.startsWith(next + path.sep))
  if (nested) {
    json(res, 400, { error: '新位置不能位于当前图片目录内部，也不能反过来包含它' })
    return
  }

  // 尝试创建目录，顺便验证路径是否可写
  try {
    fs.mkdirSync(next, { recursive: true })
  } catch (e) {
    json(res, 400, { error: `无法创建该目录：${e.message}` })
    return
  }
  try {
    fs.accessSync(next, fs.constants.W_OK)
  } catch {
    json(res, 400, { error: '该目录没有写入权限' })
    return
  }

  /* ------------------------------------------------------------
   *  搬迁老图片
   *  ------------------------------------------------------------
   *  历史会话里存的是「相对路径」（<会话目录>/<文件名>），
   *  换位置后服务会拿新的 IMAGE_ROOT 去拼这个相对路径，
   *  不搬的话老图就全 404 了。这里把整个旧目录内容并过去。
   * ------------------------------------------------------------ */
  let moved = 0
  let skipped = 0
  let moveError = null

  if (shouldMove && fs.existsSync(prev)) {
    try {
      const r = mergeMoveDir(prev, next)
      moved = r.moved
      skipped = r.skipped
    } catch (e) {
      moveError = e.message || String(e)
    }
  }

  IMAGE_ROOT = next
  saveConfig()
  console.log(`  图片保存位置已改为: ${IMAGE_ROOT}`)
  if (moved) console.log(`  已搬迁 ${moved} 张图片${skipped ? `，跳过 ${skipped} 个同名文件` : ''}`)
  if (moveError) console.log(`  ⚠ 搬迁失败：${moveError}`)

  json(res, 200, {
    ok: true,
    imageDir: IMAGE_ROOT,
    moved,
    skipped,
    moveError,
    previousDir: prev,
  })
}

/**
 * 把 src 目录里的全部内容合并到 dst（用于换保存位置时搬迁老图片）
 * - 同名文件不覆盖，跳过（避免误伤新位置的图）
 * - 优先 rename（同盘时瞬间完成），跨盘失败则退回复制+删除
 * - 搬完尝试删掉空的旧目录；非空（说明有跳过或失败）就保留
 */
function mergeMoveDir(src, dst) {
  let moved = 0
  let skipped = 0

  const walk = (from, to) => {
    fs.mkdirSync(to, { recursive: true })
    for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
      const s = path.join(from, ent.name)
      const d = path.join(to, ent.name)

      if (ent.isDirectory()) {
        walk(s, d)
        continue
      }
      if (!ent.isFile()) continue
      // 只搬图片和对话记录，其它零散文件不管
      if (!/\.(png|jpe?g|webp|json)$/i.test(ent.name)) continue

      if (fs.existsSync(d)) {
        skipped++
        continue
      }
      try {
        fs.renameSync(s, d) // 同一个盘，瞬间完成
      } catch {
        fs.copyFileSync(s, d) // 跨盘
        fs.unlinkSync(s)
      }
      moved++
    }
  }

  walk(src, dst)

  // 旧目录空了就删掉，不空就留着（里面还有跳过的文件）
  try {
    if (fs.readdirSync(src).length === 0) fs.rmdirSync(src)
  } catch {
    /* 删不掉也无所谓 */
  }

  return { moved, skipped }
}

/**
 * 让用户能在文件管理器里直接打开保存目录
 *   GET /__reveal              → 打开图片根目录
 *   GET /__reveal/<目录>/<文件> → 打开该文件所在目录，并选中这个文件
 *
 * 安全：路径必须落在 IMAGE_ROOT 内，且是图片扩展名
 * （与 /__file 同一套校验，防止被拿来打开任意文件）
 */
function handleReveal(req, res) {
  let rel = ''
  try {
    rel = decodeURIComponent((req.url || '').replace(/^\/__reveal\/?/, '').split('?')[0])
  } catch {
    json(res, 400, { error: '路径编码不合法' })
    return
  }

  // 不带路径：打开根目录
  if (!rel) {
    try {
      fs.mkdirSync(IMAGE_ROOT, { recursive: true })
    } catch {
      /* ignore */
    }
    try {
      const cmd =
        process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open'
      spawn(cmd, [IMAGE_ROOT], { detached: true, stdio: 'ignore' }).unref()
      json(res, 200, { ok: true })
    } catch (e) {
      json(res, 500, { error: e.message })
    }
    return
  }

  // 带路径：定位到具体文件
  const root = path.resolve(IMAGE_ROOT)
  const full = path.resolve(root, rel)
  if (full !== root && !full.startsWith(root + path.sep)) {
    json(res, 403, { error: '非法路径' })
    return
  }
  if (!/\.(png|jpe?g|webp)$/i.test(full)) {
    json(res, 403, { error: '只允许定位图片文件' })
    return
  }
  if (!fs.existsSync(full)) {
    json(res, 404, { error: `找不到图片: ${rel}` })
    return
  }

  try {
    if (process.platform === 'win32') {
      // explorer /select, 会打开父目录并选中该文件。
      // 注意：explorer 成功时也可能返回非 0 退出码，所以这里不检查结果。
      spawn('explorer', [`/select,${full}`], { detached: true, stdio: 'ignore' }).unref()
    } else if (process.platform === 'darwin') {
      // -R 在 Finder 中定位文件
      spawn('open', ['-R', full], { detached: true, stdio: 'ignore' }).unref()
    } else {
      // Linux 没有统一的「选中」能力，退而打开所在目录
      spawn('xdg-open', [path.dirname(full)], { detached: true, stdio: 'ignore' }).unref()
    }
    json(res, 200, { ok: true, path: full })
  } catch (e) {
    json(res, 500, { error: e.message })
  }
}

/* ============================================================
 *  CORS 转发
 * ============================================================ */

/* ============================================================
 *  代理目标白名单
 *  ------------------------------------------------------------
 *  为什么需要白名单：
 *    这个服务在 127.0.0.1 上监听。如果没有白名单，任何网页
 *    （包括你随手打开的钓鱼站）都能把 /__proxy 当成跳板，
 *    借你的网络去请求任意地址，这就是「开放代理」。
 *  但是白名单确实会妨碍换中转站，所以：
 *    · 默认放行所有「看起来像 API 服务」的地址，见 ALLOW_ANY
 *    · 设 ALLOW_ANY=1 可以完全放开（本机自用没问题）
 *    · 私网/本机地址永远禁止（防止探测内网）
 * ============================================================ */

/** 永远禁止的目标：本机与内网地址，避免被用来探测局域网 */
function isPrivateHost(host) {
  // URL.hostname 对 IPv6 会带方括号，如 [::1]，先去掉
  let h = host.toLowerCase().trim()
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)

  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '0.0.0.0') return true

  // IPv6：回环、未指定、链路本地、唯一本地地址
  if (h === '::1' || h === '::') return true
  if (/^fe80:/i.test(h)) return true
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true
  // IPv4-mapped IPv6，如 ::ffff:127.0.0.1
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(h)
  if (mapped && isPrivateHost(mapped[1])) return true

  // IPv4 私网段
  if (/^127\./.test(h)) return true
  if (/^10\./.test(h)) return true
  if (/^192\.168\./.test(h)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true
  if (/^169\.254\./.test(h)) return true
  if (/^0\./.test(h)) return true

  return false
}

function isAllowedHost(host) {
  if (!host) return false

  // 私网地址一律禁止
  if (isPrivateHost(host)) return false

  // 完全放开模式（本机自用最方便）
  if (process.env.ALLOW_ANY === '1' || process.env.ALLOW_ANY === 'true') return true

  const h = host.toLowerCase()

  // 白名单里可以写 *.example.com 表示放行所有子域
  const patterns = (process.env.ALLOW_HOSTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)

  const builtin = ['api.openai.com', 'openai.azure.com', 'generativelanguage.googleapis.com']
  const all = [...builtin, ...patterns]

  return all.some((p) => {
    // 写 * 表示放行所有外部域名（本机/内网仍被禁止）
    if (p === '*') return true
    if (p.startsWith('*.')) {
      // 通配符：只匹配子域，且必须是完整的一段
      const base = p.slice(2)
      return h === base || h.endsWith('.' + base)
    }
    // 精确匹配，或作为子域出现（必须带点，避免 notapi.openai.com 混进来）
    return h === p || h.endsWith('.' + p)
  })
}

async function handleProxy(req, res) {
  const target = req.headers['x-target-url']
  if (!target || typeof target !== 'string') {
    json(res, 400, { error: { message: '缺少 X-Target-URL 请求头' } })
    return
  }
  let url
  try {
    url = new URL(target)
  } catch {
    json(res, 400, { error: { message: `X-Target-URL 不是合法 URL: ${target}` } })
    return
  }
  if (!/^https?:$/.test(url.protocol)) {
    json(res, 400, { error: { message: '只支持 http/https' } })
    return
  }
  if (isPrivateHost(url.hostname)) {
    json(res, 403, {
      error: {
        message:
          `禁止访问本机/内网地址（${url.hostname}）。\n` +
          `这是防止代理被用来探测局域网的固定限制，无法通过配置放开。`,
      },
    })
    return
  }
  if (!isAllowedHost(url.hostname)) {
    json(res, 403, {
      error: {
        message:
          `主机 ${url.hostname} 不在白名单里。\n\n` +
          `解决办法（任选其一）：\n` +
          `  1. 编辑「启动.bat」，把该域名加进 ALLOW_HOSTS，用逗号分隔；\n` +
          `  2. 想换哪家都能用，就把 ALLOW_HOSTS 改成 *  （即 set "ALLOW_HOSTS=*"）；\n` +
          `  3. 彻底不限制，在「启动.bat」里加一行  set "ALLOW_ANY=1"。`,
      },
    })
    return
  }

  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = Buffer.concat(chunks)

  const fwd = {}
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase()
    if (['host', 'x-target-url', 'origin', 'referer', 'connection', 'content-length', 'accept-encoding'].includes(lk)) continue
    fwd[k] = v
  }
  if (body.length) fwd['content-length'] = String(body.length)

  const timeoutMs = Number(process.env.PROXY_TIMEOUT_MS || 900000)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)

  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers: fwd,
      body: ['GET', 'HEAD'].includes(req.method || 'GET') ? undefined : body,
      signal: ctrl.signal,
      redirect: 'follow',
    })
    clearTimeout(timer)

    const out = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    }
    const ct = upstream.headers.get('content-type')
    if (ct) out['Content-Type'] = ct
    res.writeHead(upstream.status, out)
    res.end(Buffer.from(await upstream.arrayBuffer()))
  } catch (e) {
    clearTimeout(timer)
    const aborted = e?.name === 'AbortError'
    json(res, aborted ? 504 : 502, {
      error: { message: aborted ? `转发超时（${Math.round(timeoutMs / 1000)} 秒）` : `转发失败: ${e?.message || e}` },
    })
  }
}

/* ============================================================
 *  静态文件
 * ============================================================ */

function serveStatic(req, res) {
  let rel = decodeURIComponent((req.url || '/').split('?')[0])
  if (rel === '/' || rel === '') rel = '/index.html'
  const filePath = path.join(DIST, rel)
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403).end('forbidden')
    return
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      fs.readFile(path.join(DIST, 'index.html'), (e2, html) => {
        if (e2) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('还没有构建产物。请先运行: npm run build')
          return
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'] }).end(html)
      })
      return
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' }).end(buf)
  })
}

/* ============================================================
 *  启动（端口被占用时自动顺延）
 * ============================================================ */

const server = http.createServer((req, res) => {
  const url = req.url || ''

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Max-Age': '86400',
    })
    res.end()
    return
  }

  if (url.startsWith('/__proxy')) return void handleProxy(req, res)
  if (url.startsWith('/__save')) return void handleSave(req, res)
  if (url.startsWith('/__file/')) return void handleFile(req, res)
  if (url.startsWith('/__list')) return void handleList(req, res)
  if (url.startsWith('/__reveal')) return void handleReveal(req, res)
  if (url.startsWith('/__sessions')) {
    if (req.method === 'POST') return void handleSetSessions(req, res)
    return void handleGetSessions(req, res)
  }
  if (url.startsWith('/__config')) {
    if (req.method === 'POST') return void handleSetConfig(req, res)
    return void handleGetConfig(req, res)
  }
  serveStatic(req, res)
})

function listen(port, attemptsLeft = 12) {
  const onError = (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log(`  端口 ${port} 被占用，改用 ${port + 1} …`)
      setTimeout(() => listen(port + 1, attemptsLeft - 1), 60)
      return
    }
    console.error('\n  ✕ 启动失败:', err.message, '\n')
    process.exit(1)
  }
  server.once('error', onError)
  server.listen(port, '127.0.0.1', () => {
    server.off('error', onError)
    PORT = port
    const line = '─'.repeat(46)
    console.log('')
    console.log('  GPT Image Studio is running')
    console.log('  ' + line)
    console.log(`  URL:        http://127.0.0.1:${PORT}`)
    console.log(`  Images:     ${IMAGE_ROOT}`)
    console.log(`  Project:    ${__dirname}`)
    if (process.env.ALLOW_HOSTS) console.log(`  AllowHosts: ${process.env.ALLOW_HOSTS}`)
    console.log('  ' + line)
    console.log('  Close this window to stop the server.')
    console.log('')
    // 把实际端口写出来，方便 bat 打开正确的地址
    try {
      fs.writeFileSync(path.join(__dirname, '.port'), String(PORT))
    } catch {}
  })
}

listen(PORT)
