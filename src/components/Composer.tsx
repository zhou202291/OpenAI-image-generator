import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Attachment, GenImage, GenParams, Settings, Turn } from '../types'
import { ApiError, detectProxy, generateImage, isProxyAvailable, measureImage } from '../api'

interface Props {
  api: Settings['api']
  params: GenParams
  /** 当前会话的创建时间戳，作为图片落盘的目录名 */
  sessionStamp: string
  busy: boolean
  setBusy: (b: boolean) => void
  onSend: (text: string, attachments: Attachment[], optimistic: { user: Turn; assistant: Turn }) => void
  patchAssistant: (turnId: string, patch: Partial<Turn>) => void
  onOpenImage: (images: GenImage[], index: number) => void
  onUseAsRef: (dataUrl: string) => void
  attachments: Attachment[]
  setAttachments: (a: Attachment[]) => void
  error: string | null
  setError: (s: string | null) => void
  hasKey: boolean
  openSettings: () => void
}

const EXAMPLES = [
  '一只戴宇航头盔的柴犬，电影感打光，超写实',
  '极简风格的咖啡店 logo，线条干净，白底',
  '赛博朋克城市夜景，霓虹灯倒影在湿漉的路面',
  '水彩画风格的江南水乡，清晨薄雾',
]

export default function Composer({
  api, params, sessionStamp, busy, setBusy, onSend, patchAssistant, onOpenImage, onUseAsRef,
  attachments, setAttachments, error, setError, hasKey, openSettings,
}: Props) {
  const [text, setText] = useState('')
  const [partial, setPartial] = useState<{ src: string; index: number } | null>(null)
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  /** 让输入框跟着内容长高 */
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(220, ta.scrollHeight) + 'px'
  }, [text])

  const canSend = useMemo(() => text.trim().length > 0 && !busy && hasKey, [text, busy, hasKey])

  const addFiles = useCallback(async (files: FileList | null) => {
    if (!files || !files.length) return
    const arr = Array.from(files)
    const { filesToAttachments } = await import('../store')
    const added = await filesToAttachments(arr)
    setAttachments([...attachments, ...added].slice(0, 16))
  }, [attachments, setAttachments])

  /** 粘贴图片也能当参考图 */
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      const files: File[] = []
      for (const it of items) {
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          const f = it.getAsFile()
          if (f) files.push(f)
        }
      }
      if (files.length) {
        e.preventDefault()
        const dt = new DataTransfer()
        files.forEach((f) => dt.items.add(f))
        addFiles(dt.files)
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [addFiles])

  const submit = async () => {
    const prompt = text.trim()
    if (!prompt || busy) return
    if (!hasKey) { setError('请先在设置里填写 API Key。'); return }

    setError(null)
    setText('')
    setPartial(null)

    // 先把用户消息和占位的助手消息放进会话，界面立刻有反馈
    const now = Date.now()
    const userTurn: Turn = {
      id: `t-${now}-u-${Math.random().toString(36).slice(2, 6)}`,
      role: 'user',
      text: prompt,
      attachments: attachments.length ? [...attachments] : undefined,
      createdAt: now,
    }
    const assistantTurn: Turn = {
      id: `t-${now}-a-${Math.random().toString(36).slice(2, 6)}`,
      role: 'assistant',
      images: [],
      createdAt: now + 1,
    }
    const usedAttachments = [...attachments]
    onSend(prompt, usedAttachments, { user: userTurn, assistant: assistantTurn })
    setAttachments([])
    setBusy(true)

    try {
      await detectProxy()
      const r = await generateImage(api, params, prompt, usedAttachments, sessionStamp, {
        onPartial: (dataUrl, index) => setPartial({ src: dataUrl, index }),
      })
      // 兜底补测尺寸
      for (const img of r.images) {
        if (!img.width) {
          const d = await measureImage(img.dataUrl)
          img.width = d.width
          img.height = d.height
        }
      }
      patchAssistant(assistantTurn.id, {
        images: r.images,
        usedParams: params,
        endpoint: r.endpoint,
        elapsedMs: r.elapsedMs,
        usage: r.usage,
      })
    } catch (e: any) {
      const err = e as ApiError
      patchAssistant(assistantTurn.id, {
        error: (err.detail || err.message || '未知错误') + (err.hint ? `\n\n💡 ${err.hint}` : ''),
        usedParams: params,
      })
    } finally {
      setPartial(null)
      setBusy(false)
      taRef.current?.focus()
    }
  }

  return (
    <div className="composer">
      {error && (
        <div className="composer-error">
          <span>⚠ {error}</span>
          <button onClick={() => setError(null)}>✕</button>
        </div>
      )}

      {/* 参考图预览 */}
      {attachments.length > 0 && (
        <div className="ref-strip">
          <span className="ref-label">参考图 {attachments.length} 张（将走「改图」接口）</span>
          <div className="ref-list">
            {attachments.map((a) => (
              <div key={a.id} className="ref-item">
                <img src={a.dataUrl} alt={a.name} onClick={() => onUseAsRef(a.dataUrl)} />
                <button className="ref-del" onClick={() => setAttachments(attachments.filter((x) => x.id !== a.id))} title="移除">✕</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 流式草稿预览 */}
      {partial && (
        <div className="partial-wrap">
          <img
            className="partial"
            src={partial.src}
            alt="草稿"
            title="点击放大查看"
            onClick={() => onOpenImage(
              [{ id: `partial-${partial.index}`, dataUrl: partial.src }],
              0,
            )}
          />
          <span className="partial-tag">草稿 {partial.index + 1}…</span>
        </div>
      )}

      {/* 空状态引导 */}
      {!busy && text.length === 0 && (
        <div className="examples">
          {EXAMPLES.map((ex) => (
            <button key={ex} className="example" onClick={() => { setText(ex); taRef.current?.focus() }}>{ex}</button>
          ))}
        </div>
      )}

      <div className="input-row">
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          hidden
          onChange={(e) => { addFiles(e.target.files); e.target.value = '' }}
        />
        <button
          className="icon-btn attach"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          title="添加参考图（也可直接 Ctrl+V 粘贴图片）"
        >📎</button>

        <textarea
          ref={taRef}
          value={text}
          rows={1}
          placeholder={hasKey ? '描述你想生成的画面…  改图时先加参考图，再说「把它变成蓝色」' : '请先点右上角「设置」填写 API Key'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          disabled={busy}
        />

        <button className="send" onClick={submit} disabled={!canSend} title="Enter 发送，Shift+Enter 换行">
          {busy ? <span className="spin" /> : '生成'}
        </button>
      </div>

      <div className="composer-foot">
        <span>
          {attachments.length > 0
            ? '将调用 /images/edits（改图）'
            : '将调用 /images/generations（生图）'}
          {isProxyAvailable() ? ' · 经本地转发' : ''}
        </span>
        {!hasKey && <button className="link" onClick={openSettings}>去设置 API Key →</button>}
      </div>
    </div>
  )
}
