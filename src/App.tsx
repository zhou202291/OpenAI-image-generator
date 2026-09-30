import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Attachment, GenImage, Session, Turn } from './types'
import { detectProxy, getConfig, isProxyAvailable, revealImageDir, revealImageFile, type RuntimeConfig } from './api'
import { newSession, newTurn, purgeLegacyData, titleFrom, useAutoScroll, useSessions, useSettings } from './store'
import ParamBar from './components/ParamBar'
import MessageList from './components/MessageList'
import Composer from './components/Composer'
import SettingsPanel from './components/SettingsPanel'
import Lightbox from './components/Lightbox'

export default function App() {
  const { settings, patchApi, patchParams, setSettings } = useSettings()
  const { sessions, setSessions, storageWarning, loaded } = useSessions(settings.maxSessions)

  const [activeId, setActiveId] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [error, setError] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [lightbox, setLightbox] = useState<{ images: GenImage[]; index: number } | null>(null)
  const [proxyOn, setProxyOn] = useState(isProxyAvailable())
  const [toast, setToast] = useState<string | null>(null)
  const [runtimeCfg, setRuntimeCfg] = useState<RuntimeConfig | null>(null)

  /* ---------- 启动：清理旧数据 + 探测服务 + 读取运行时配置 ---------- */
  useEffect(() => {
    purgeLegacyData()
    detectProxy().then((ok) => setProxyOn(ok))
    getConfig().then(setRuntimeCfg)
  }, [])

  /* ---------- 会话初始化（等磁盘数据读完再做） ---------- */
  useEffect(() => {
    if (!loaded) return
    if (sessions.length === 0) {
      const s = newSession()
      setSessions([s])
      setActiveId(s.id)
    } else if (!activeId || !sessions.some((s) => s.id === activeId)) {
      setActiveId(sessions[0].id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded])

  const active = useMemo(() => sessions.find((s) => s.id === activeId) || sessions[0], [sessions, activeId])
  const turns = active?.turns || []
  const scrollRef = useAutoScroll<HTMLDivElement>(turns.length + (busy ? 1 : 0))

  const hasKey = settings.api.apiKey.trim().length > 0

  const flash = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 2200)
  }, [])

  /* ---------- 会话增删 ---------- */
  const createSession = useCallback(() => {
    const s = newSession()
    setSessions((prev) => [s, ...prev].slice(0, settings.maxSessions))
    setActiveId(s.id)
    setAttachments([])
    return s.id
  }, [setSessions, settings.maxSessions])

  const deleteSession = useCallback((id: string) => {
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id)
      if (next.length === 0) {
        const s = newSession()
        setActiveId(s.id)
        return [s]
      }
      if (id === activeId) setActiveId(next[0].id)
      return next
    })
  }, [setSessions, activeId])

  const renameSession = useCallback((id: string) => {
    const cur = sessions.find((s) => s.id === id)
    const name = prompt('会话名称', cur?.title || '')
    if (name === null) return
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title: name.trim() || s.title } : s)))
  }, [sessions, setSessions])

  /* ---------- 往当前会话追加消息 ---------- */
  const appendTurns = useCallback((sessionId: string, newTurns: Turn[], titleIfNew?: string) => {
    setSessions((prev) => {
      const idx = prev.findIndex((s) => s.id === sessionId)
      if (idx === -1) return prev
      const s = prev[idx]
      const updated: Session = {
        ...s,
        turns: [...s.turns, ...newTurns],
        title: s.turns.length === 0 && titleIfNew ? titleIfNew : s.title,
        updatedAt: Date.now(),
      }
      const next = [...prev]
      next[idx] = updated
      // 按更新时间排序，最近的在最上面
      next.sort((a, b) => b.updatedAt - a.updatedAt)
      return next
    })
  }, [setSessions])

  const patchAssistant = useCallback((turnId: string, patch: Partial<Turn>) => {
    setSessions((prev) =>
      prev.map((s) => {
        if (!s.turns.some((t) => t.id === turnId)) return s
        return {
          ...s,
          updatedAt: Date.now(),
          turns: s.turns.map((t) => (t.id === turnId ? { ...t, ...patch } : t)),
        }
      }),
    )
  }, [setSessions])

  /* ---------- 发送 ---------- */
  const handleSend = useCallback((
    text: string,
    _atts: Attachment[],
    optimistic: { user: Turn; assistant: Turn },
  ) => {
    let sid = activeId
    if (!sid || !sessions.some((s) => s.id === sid)) sid = createSession()
    appendTurns(sid, [optimistic.user, optimistic.assistant], titleFrom(text || '图片编辑'))
  }, [activeId, sessions, createSession, appendTurns])

  /* ---------- 重跑某条提示词 ---------- */
  const handleRerun = useCallback((text: string, atts?: Attachment[]) => {
    if (!text.trim() || busy) return
    const now = Date.now()
    const user = newTurn('user', { text, attachments: atts ? [...atts] : undefined })
    const assistant = newTurn('assistant', { images: [] })
    // 直接复用 Composer 的发送流程会更绕，这里就地发起
    handleSend(text, atts || [], { user, assistant })
    setPendingRun({ prompt: text, attachments: atts || [], assistantId: assistant.id, at: now })
  }, [busy, handleSend])

  // 一个轻量的“待执行”信号，交给下方 effect 真正调用 API
  const [pendingRun, setPendingRun] = useState<{ prompt: string; attachments: Attachment[]; assistantId: string; at: number } | null>(null)

  useEffect(() => {
    if (!pendingRun || busy) return
    let cancelled = false
    ;(async () => {
      setBusy(true)
      const { generateImage, ApiError } = await import('./api')
      // 重跑时把结果写回当前会话的目录
      const stamp = sessions.find((s) => s.turns.some((t) => t.id === pendingRun.assistantId))?.stamp
      try {
        await detectProxy()
        const r = await generateImage(
          settings.api, settings.params, pendingRun.prompt, pendingRun.attachments,
          stamp || '', {},
        )
        if (cancelled) return
        patchAssistant(pendingRun.assistantId, {
          images: r.images,
          usedParams: settings.params,
          endpoint: r.endpoint,
          elapsedMs: r.elapsedMs,
          usage: r.usage,
        })
      } catch (e: any) {
        if (cancelled) return
        const err = e as InstanceType<typeof ApiError>
        patchAssistant(pendingRun.assistantId, {
          error: (err.detail || err.message || '未知错误') + (err.hint ? `\n\n💡 ${err.hint}` : ''),
          usedParams: settings.params,
        })
      } finally {
        if (!cancelled) { setBusy(false); setPendingRun(null) }
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRun])

  /* ---------- 图片操作 ---------- */
  const download = useCallback((dataUrl: string, name: string) => {
    const a = document.createElement('a')
    a.href = dataUrl
    a.download = name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    flash('已开始下载')
  }, [flash])

  const copyPath = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      flash('路径已复制，可直接粘到资源管理器地址栏')
    } catch {
      flash(text)
    }
  }, [flash])

  /** 在文件资源管理器里定位到某张图片 */
  const revealFile = useCallback(async (rel: string) => {
    const ok = await revealImageFile(rel)
    if (!ok) flash('无法打开所在位置，请确认本地服务仍在运行')
  }, [flash])

  const useAsRef = useCallback(async (dataUrl: string) => {
    const { measureImage } = await import('./api')
    const dim = await measureImage(dataUrl)
    setAttachments((prev) =>
      prev.some((p) => p.dataUrl === dataUrl)
        ? prev
        : [...prev, {
            id: `a-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            dataUrl,
            name: 'reference.png',
            width: dim.width,
            height: dim.height,
            bytes: Math.round((dataUrl.length * 3) / 4),
          }].slice(0, 16),
    )
    setLightbox(null)
    flash('已加入参考图，接着描述你想怎么改即可')
  }, [flash])

  const exportAll = useCallback(() => {
    const imgs: string[] = []
    for (const s of sessions) {
      for (const t of s.turns) {
        for (const im of t.images || []) imgs.push(im.dataUrl)
      }
    }
    if (!imgs.length) { flash('这个会话里还没有图片'); return }
    imgs.forEach((d, i) => {
      setTimeout(() => download(d, `export-${String(i + 1).padStart(3, '0')}.png`), i * 260)
    })
    flash(`正在导出 ${imgs.length} 张图片…`)
  }, [sessions, download, flash])

  /* ---------- 快捷键 ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && lightbox) setLightbox(null)
      if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); setShowSettings(true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightbox])

  const imageCount = useMemo(
    () => turns.reduce((n, t) => n + (t.images?.length || 0), 0),
    [turns],
  )

  return (
    <div className="app">
      {/* ================= 侧栏 ================= */}
      <aside className={`sidebar ${sidebarOpen ? '' : 'collapsed'}`}>
        <div className="sb-head">
          <button className="new-chat" onClick={createSession}>＋ 新对话</button>
          <button className="icon-btn" onClick={() => setSidebarOpen((v) => !v)} title={sidebarOpen ? '收起' : '展开'}>
            {sidebarOpen ? '«' : '»'}
          </button>
        </div>

        {sidebarOpen && (
          <>
            <div className="sb-list">
              {sessions.map((s) => (
                <div
                  key={s.id}
                  className={`sb-item ${s.id === activeId ? 'active' : ''}`}
                  onClick={() => setActiveId(s.id)}
                >
                  <div className="sb-item-main">
                    <div className="sb-title">{s.title}</div>
                    <div className="sb-sub">
                      {s.turns.filter((t) => t.role === 'assistant').length} 次生成 ·{' '}
                      {new Date(s.updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}
                    </div>
                  </div>
                  <div className="sb-item-actions">
                    <button onClick={(e) => { e.stopPropagation(); renameSession(s.id) }} title="重命名">✎</button>
                    <button onClick={(e) => { e.stopPropagation(); if (confirm('删除这个会话？')) deleteSession(s.id) }} title="删除">🗑</button>
                  </div>
                </div>
              ))}
            </div>
            <div className="sb-foot">
              <button className="link" onClick={exportAll}>导出全部图片</button>
              <button className="link" onClick={() => setShowSettings(true)}>设置</button>
              <span
                className="sb-storage"
                title={runtimeCfg ? `图片保存位置：${runtimeCfg.imageDir}\n\n点击在文件管理器中打开` : '图片保存位置'}
                onClick={async () => {
                  const ok = await revealImageDir()
                  if (!ok) flash('无法打开目录，请确认启动服务仍在运行')
                }}
              >
                💾 {runtimeCfg ? runtimeCfg.imageDirRelative : './image'}
              </span>
            </div>
          </>
        )}
      </aside>

      {/* ================= 主区 ================= */}
      <main className="main">
        <header className="topbar">
          <div className="brand">
            <span className="logo">🎨</span>
            <div>
              <h1>GPT 生图工作台</h1>
              <p className="sub">
                {settings.api.baseUrl.replace(/^https?:\/\//, '').replace(/\/v1$/, '')}
                <span className={`dot ${hasKey ? 'ok' : 'bad'}`} title={hasKey ? '已配置密钥' : '未配置密钥'} />
                <span className={`dot ${proxyOn ? 'ok' : 'warn'}`} title={proxyOn ? '本地转发已启用（可绕过跨域限制）' : '未启用本地转发，跨域接口可能失败'} />
                <span className="dot-label">{proxyOn ? '转发中' : '直连'}</span>
              </p>
            </div>
          </div>
          <div className="top-actions">
            {imageCount > 0 && <span className="count">本会话 {imageCount} 张</span>}
            <button className="icon-btn" onClick={() => setShowSettings(true)} title="设置 (Ctrl+,)">⚙</button>
          </div>
        </header>

        {/* 未启用转发 + 未配置密钥的提示条 */}
        {!proxyOn && (
          <div className="banner warn">
            <span>
              当前是<strong>浏览器直连</strong>模式。如果你的接口返回跨域错误，请关闭本页，
              改用项目目录下的 <code>启动.bat</code> 打开 —— 它会启动本地转发服务，绕过浏览器的跨域限制。
            </span>
          </div>
        )}
        {storageWarning && <div className="banner warn"><span>{storageWarning}</span></div>}

        <ParamBar params={settings.params} api={settings.api} onChange={patchParams} disabled={busy} />

        <div className="messages-wrap" ref={scrollRef}>
          {turns.length === 0 ? (
            <div className="empty">
              <div className="empty-icon">🖼️</div>
              <h2>开始你的第一张图</h2>
              <p>在下面描述画面即可生成。想改图时，点图片上的「改这张」或直接拖入参考图，再用一句话描述要改什么。</p>
              <ul>
                <li><strong>生图</strong>：直接打字，调用 <code>/images/generations</code></li>
                <li><strong>改图</strong>：附上参考图，调用 <code>/images/edits</code>，可以连续多轮修改</li>
                <li><strong>多图融合</strong>：一次附上多张参考图</li>
              </ul>
            </div>
          ) : (
            <MessageList
              turns={turns}
              onOpenImage={(images, index) => setLightbox({ images, index })}
              onDownload={download}
              onUseAsRef={useAsRef}
              onRerun={handleRerun}
              onCopyPath={copyPath}
              onRevealFile={revealFile}
              isLast={!busy}
            />
          )}
        </div>

        <Composer
          api={settings.api}
          params={settings.params}
          sessionStamp={active?.stamp || ''}
          busy={busy}
          setBusy={setBusy}
          onSend={handleSend}
          patchAssistant={patchAssistant}
          onOpenImage={(images, index) => setLightbox({ images, index })}
          onUseAsRef={useAsRef}
          attachments={attachments}
          setAttachments={setAttachments}
          error={error}
          setError={setError}
          hasKey={hasKey}
          openSettings={() => setShowSettings(true)}
        />
      </main>

      {/* ================= 浮层 ================= */}
      {showSettings && (
        <SettingsPanel
          api={settings.api}
          patchApi={patchApi}
          maxSessions={settings.maxSessions}
          setMaxSessions={(n) => setSettings((s) => ({ ...s, maxSessions: n }))}
          runtimeCfg={runtimeCfg}
          onConfigChanged={setRuntimeCfg}
          onClose={() => setShowSettings(false)}
        />
      )}

      {lightbox && (
        <Lightbox
          images={lightbox.images}
          index={lightbox.index}
          onClose={() => setLightbox(null)}
          onIndex={(i) => setLightbox({ ...lightbox, index: i })}
          onDownload={download}
          onUseAsRef={useAsRef}
          onCopyPath={copyPath}
          onRevealFile={revealFile}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
