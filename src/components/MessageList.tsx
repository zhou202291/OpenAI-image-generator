import type { GenImage, Turn } from '../types'
import { QUALITY_LABELS, SIZE_CHOICES } from '../types'

interface Props {
  turns: Turn[]
  onOpenImage: (images: GenImage[], index: number) => void
  onDownload: (dataUrl: string, name: string) => void
  onUseAsRef: (dataUrl: string) => void
  onRerun: (text: string, attachments: Turn['attachments']) => void
  onCopyPath: (text: string) => void
  /** 在文件管理器里定位到这张图（打开所在文件夹并选中） */
  onRevealFile: (rel: string) => void
  isLast: boolean
}

function sizeLabel(v: string) {
  const s = SIZE_CHOICES.find((x) => x.value === v)
  return s ? s.label : v
}

function Summary({ turn }: { turn: Turn }) {
  const p = turn.usedParams
  if (!p) return null
  return (
    <div className="turn-meta">
      <span className="meta-chip">{p.model}</span>
      <span className="meta-chip">画质 {QUALITY_LABELS[p.quality] || p.quality}</span>
      <span className="meta-chip">{sizeLabel(p.size)}</span>
      {p.n > 1 && <span className="meta-chip">{p.n} 张</span>}
      {p.background !== 'auto' && <span className="meta-chip">背景 {p.background === 'transparent' ? '透明' : '不透明'}</span>}
      {p.output_format !== 'png' && <span className="meta-chip">{p.output_format.toUpperCase()}</span>}
      {turn.endpoint && <span className="meta-chip dim">{turn.endpoint === 'edits' ? '改图' : '生图'}</span>}
      {turn.elapsedMs ? <span className="meta-chip dim">{(turn.elapsedMs / 1000).toFixed(1)}s</span> : null}
      {turn.usage?.total ? <span className="meta-chip dim">{turn.usage.total} tokens</span> : null}
    </div>
  )
}

/** 从 dataUrl 猜一个合适的扩展名 */
function extOf(dataUrl: string) {
  const m = /^data:image\/(\w+)/.exec(dataUrl)
  const t = m?.[1] || 'png'
  return t === 'jpeg' ? 'jpg' : t
}

/** 文件名：优先用落盘时的真实文件名 */
function nameOf(img: GenImage, i: number) {
  if (img.relPath) return img.relPath.split('/').pop() || `image-${i + 1}.png`
  return `gpt-image-${img.id}.${extOf(img.dataUrl)}`
}

export default function MessageList({ turns, onOpenImage, onDownload, onUseAsRef, onRerun, onCopyPath, onRevealFile, isLast }: Props) {
  return (
    <div className="messages">
      {turns.map((turn, ti) => {
        const isLastTurn = ti === turns.length - 1

        if (turn.role === 'user') {
          return (
            <div key={turn.id} className="msg user">
              {turn.attachments && turn.attachments.length > 0 && (
                <div className="msg-attachments">
                  {turn.attachments.map((a) => (
                    <img
                      key={a.id}
                      src={a.dataUrl}
                      alt={a.name}
                      title="点击用作参考图"
                      onClick={() => onUseAsRef(a.dataUrl)}
                    />
                  ))}
                </div>
              )}
              <div className="bubble">{turn.text}</div>
              <div className="msg-actions">
                <button onClick={() => onRerun(turn.text || '', turn.attachments)}>重试</button>
              </div>
            </div>
          )
        }

        // 助手消息
        const pending = isLastTurn && isLast && (!turn.images || turn.images.length === 0) && !turn.error
        return (
          <div key={turn.id} className="msg assistant">
            {turn.error && (
              <div className="err-box">
                <div className="err-title">生成失败</div>
                <pre>{turn.error}</pre>
                <button onClick={() => onRerun(lastUserText(turns, ti), lastUserAttachments(turns, ti))}>再试一次</button>
              </div>
            )}

            {pending && (
              <div className="thinking">
                <span className="spin dark" />
                <span>正在绘制…大图通常需要 20-60 秒，请勿关闭页面</span>
                <span className="thinking-bar" />
              </div>
            )}

            {turn.images && turn.images.length > 0 && (
              <>
                <div className={`img-grid n${Math.min(turn.images.length, 4)}`}>
                  {turn.images.map((img, i) => (
                    <figure key={img.id} className="img-card">
                      <img
                        src={img.dataUrl}
                        alt={img.prompt || ''}
                        loading="lazy"
                        onClick={() => onOpenImage(turn.images!, i)}
                      />
                      <figcaption>
                        <span className="fig-meta">
                          {img.width ? `${img.width}×${img.height}` : ''}
                          {img.bytes ? ` · ${(img.bytes / 1024 / 1024).toFixed(2)}MB` : ''}
                        </span>
                        <span className="card-actions">
                          <button onClick={() => onDownload(img.dataUrl, nameOf(img, i))} title="下载到浏览器默认位置">下载</button>
                          {img.relPath && (
                            <button
                              onClick={() => onRevealFile(img.relPath!)}
                              title="在文件资源管理器中打开并选中这个文件"
                            >打开位置</button>
                          )}
                          {img.fullPath && (
                            <button onClick={() => onCopyPath(img.fullPath!)} title={img.fullPath}>复制路径</button>
                          )}
                          <button onClick={() => onUseAsRef(img.dataUrl)}>改这张</button>
                        </span>
                      </figcaption>
                      {img.relPath && (
                        <div
                          className="fig-path"
                          title={`${img.fullPath}\n\n点击复制路径`}
                          onClick={() => onCopyPath(img.fullPath || img.relPath!)}
                        >
                          💾 {img.relPath}
                        </div>
                      )}
                    </figure>
                  ))}
                </div>
                <Summary turn={turn} />
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}

function lastUserText(turns: Turn[], beforeIndex: number): string {
  for (let i = beforeIndex - 1; i >= 0; i--) {
    if (turns[i].role === 'user') return turns[i].text || ''
  }
  return ''
}

function lastUserAttachments(turns: Turn[], beforeIndex: number): Turn['attachments'] {
  for (let i = beforeIndex - 1; i >= 0; i--) {
    if (turns[i].role === 'user') return turns[i].attachments
  }
  return undefined
}
