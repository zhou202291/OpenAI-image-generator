import { useCallback, useEffect, useRef, useState } from 'react'
import type { Attachment, GenParams, Session, Settings, Turn } from './types'
import { DEFAULT_SETTINGS } from './types'
import { blobToDataUrl, measureImage, serviceOrigin } from './api'

const KEY_SETTINGS = 'gis.settings.v1'
const KEY_SESSIONS = 'gis.sessions.v2' // v2：不再存 base64，图片改为磁盘路径
const OLD_KEYS = ['gis.sessions.v1']

/** 一次性清理旧版本残留的臃肿数据 */
export function purgeLegacyData() {
  for (const k of OLD_KEYS) {
    try {
      localStorage.removeItem(k)
    } catch {
      /* ignore */
    }
  }
}

/* ============================================================
 *  时间戳：20260929212100（年月日时分秒）
 * ============================================================ */

export function stampOf(d: number | Date = new Date()): string {
  const t = typeof d === 'number' ? new Date(d) : d
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    t.getFullYear() + p(t.getMonth() + 1) + p(t.getDate()) + p(t.getHours()) + p(t.getMinutes()) + p(t.getSeconds())
  )
}

/* ============================================================
 *  设置持久化
 * ============================================================ */

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY_SETTINGS)
    if (!raw) return DEFAULT_SETTINGS
    const parsed = JSON.parse(raw)
    return {
      api: { ...DEFAULT_SETTINGS.api, ...(parsed.api || {}) },
      params: { ...DEFAULT_SETTINGS.params, ...(parsed.params || {}) },
      maxSessions: parsed.maxSessions ?? DEFAULT_SETTINGS.maxSessions,
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(loadSettings)

  useEffect(() => {
    try {
      localStorage.setItem(KEY_SETTINGS, JSON.stringify(settings))
    } catch {
      /* 配额溢出时忽略 */
    }
  }, [settings])

  const patchApi = useCallback((patch: Partial<Settings['api']>) => {
    setSettings((s) => ({ ...s, api: { ...s.api, ...patch } }))
  }, [])

  const patchParams = useCallback((patch: Partial<GenParams>) => {
    setSettings((s) => ({ ...s, params: { ...s.params, ...patch } }))
  }, [])

  return { settings, setSettings, patchApi, patchParams }
}

/* ============================================================
 *  会话持久化
 *  ------------------------------------------------------------
 *  对话记录存到项目的 data/sessions.json（由本地服务读写），
 *  这样整个项目拷到别的机器，对话历史也跟着走。
 *  浏览器 localStorage 只作为「服务不可用时的兜底缓存」。
 * ============================================================ */

/** 从本地服务读对话记录 */
export async function fetchSessions(): Promise<{ sessions: Session[]; warning?: string }> {
  try {
    const res = await fetch(`${serviceOrigin()}/__sessions`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const j = await res.json()
    const list = Array.isArray(j?.sessions) ? j.sessions : []
    return {
      sessions: list.map((s: Session) => ({
        ...s,
        stamp: s.stamp || stampOf(s.createdAt || Date.now()),
      })),
      warning: j?.warning,
    }
  } catch {
    // 服务没起来时退回 localStorage 里可能存在的旧缓存
    return { ...loadSessionsFromCache(), warning: undefined }
  }
}

/** 把对话记录写回项目目录 */
export async function persistSessions(list: Session[]): Promise<{ ok: boolean; warning?: string }> {
  try {
    const res = await fetch(`${serviceOrigin()}/__sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessions: list }),
    })
    if (!res.ok) {
      const j = await res.json().catch(() => null)
      throw new Error(j?.error || `HTTP ${res.status}`)
    }
    // 顺手在浏览器里留一份缓存，服务没启动时还能看到历史
    try {
      localStorage.setItem(KEY_SESSIONS, JSON.stringify(list))
    } catch {
      /* 缓存写不下无所谓，主数据在磁盘上 */
    }
    return { ok: true }
  } catch (e: any) {
    return {
      ok: false,
      warning:
        `对话记录保存失败（${e?.message || '未知错误'}）。` +
        `图片已安全存到 image 目录，但对话列表可能不会保留。请确认启动服务仍在运行。`,
    }
  }
}

/** 仅用于服务不可用时的兜底 */
function loadSessionsFromCache(): { sessions: Session[]; warning?: string } {
  try {
    const raw = localStorage.getItem(KEY_SESSIONS)
    if (!raw) return { sessions: [] }
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return { sessions: [] }
    return {
      sessions: (parsed as Session[]).map((s) => ({
        ...s,
        stamp: s.stamp || stampOf(s.createdAt || Date.now()),
      })),
    }
  } catch {
    return { sessions: [], warning: '历史记录读取失败，已重新开始。' }
  }
}

export function useSessions(maxSessions: number) {
  const [sessions, setSessions] = useState<Session[]>([])
  const [storageWarning, setStorageWarning] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const saveTimer = useRef<number | null>(null)

  // 首次加载：从项目目录读
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { sessions: list, warning } = await fetchSessions()
      if (cancelled) return
      setSessions(list)
      setLoaded(true)
      if (warning) setStorageWarning(warning)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // 变更后写回（防抖 400ms，避免连续输入时频繁写盘）
  useEffect(() => {
    if (!loaded) return
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(async () => {
      const list = sessions.slice(0, Math.max(1, maxSessions))
      const { ok, warning } = await persistSessions(list)
      setStorageWarning(
        !ok
          ? warning || null
          : list.length < sessions.length
            ? `会话数超过上限 ${maxSessions}，最旧的已从列表移出（图片仍在 image 目录里）。`
            : null,
      )
    }, 400)
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
    }
  }, [sessions, maxSessions, loaded])

  return { sessions, setSessions, storageWarning, loaded }
}

/* ============================================================
 *  会话操作
 * ============================================================ */

export function newSession(): Session {
  const now = Date.now()
  return {
    id: `s-${now}-${Math.random().toString(36).slice(2, 7)}`,
    title: '新对话',
    turns: [],
    createdAt: now,
    updatedAt: now,
    stamp: stampOf(now),
  }
}

export function newTurn(role: Turn['role'], patch: Partial<Turn> = {}): Turn {
  return {
    id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    role,
    createdAt: Date.now(),
    ...patch,
  }
}

/** 用首条提示词给会话起个名 */
export function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (!t) return '新对话'
  return t.length > 22 ? t.slice(0, 22) + '…' : t
}

/* ============================================================
 *  参考图读入
 * ============================================================ */

export async function filesToAttachments(files: File[]): Promise<Attachment[]> {
  const out: Attachment[] = []
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue
    const dataUrl = await blobToDataUrl(f)
    const dim = await measureImage(dataUrl)
    out.push({
      id: `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      dataUrl,
      name: f.name || 'image.png',
      width: dim.width,
      height: dim.height,
      bytes: f.size,
    })
  }
  return out
}

/* ============================================================
 *  提示音 / 滚动等小工具
 * ============================================================ */

export function useAutoScroll<T extends HTMLElement>(dep: unknown) {
  const ref = useRef<T | null>(null)
  const pinned = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])
  useEffect(() => {
    const el = ref.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [dep])
  return ref
}
