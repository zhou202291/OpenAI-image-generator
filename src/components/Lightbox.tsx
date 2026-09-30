import { useMemo, useState } from 'react'

interface Props {
  images: { id: string; dataUrl: string; width?: number; height?: number; revisedPrompt?: string; relPath?: string; fullPath?: string }[]
  index: number
  onClose: () => void
  onIndex: (i: number) => void
  onDownload: (dataUrl: string, name: string) => void
  onUseAsRef: (dataUrl: string) => void
  onCopyPath: (text: string) => void
  /** 在文件管理器里定位到这张图 */
  onRevealFile: (rel: string) => void
}

/** 文件名：优先用落盘时的真实文件名 */
function nameOf(img: Props['images'][number], i: number) {
  if (img.relPath) return img.relPath.split('/').pop() || `image-${i + 1}.png`
  const m = /^data:image\/(\w+)/.exec(img.dataUrl)
  const t = m?.[1] || 'png'
  return `image-${i + 1}.${t === 'jpeg' ? 'jpg' : t}`
}

/** 全屏图片查看器：滚轮缩放、拖拽平移、下载、复制、作为参考图 */
export default function Lightbox({ images, index, onClose, onIndex, onDownload, onUseAsRef, onCopyPath, onRevealFile }: Props) {
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null)
  const img = images[index]

  const dimText = useMemo(() => (img?.width ? `${img.width} × ${img.height}` : ''), [img])

  if (!img) return null

  const reset = () => {
    setZoom(1)
    setOffset({ x: 0, y: 0 })
  }

  const step = (d: number) => {
    reset()
    onIndex((index + d + images.length) % images.length)
  }

  return (
    <div className="lightbox" onClick={onClose}>
      <div className="lb-bar" onClick={(e) => e.stopPropagation()}>
        <span className="lb-info">
          {images.length > 1 ? `${index + 1} / ${images.length}` : ''} {dimText}
          {zoom !== 1 && ` · ${Math.round(zoom * 100)}%`}
        </span>
        <div className="lb-actions">
          <button onClick={() => setZoom((z) => Math.min(8, z * 1.25))}>放大 +</button>
          <button onClick={() => setZoom((z) => Math.max(0.1, z / 1.25))}>缩小 −</button>
          <button onClick={reset}>原始大小</button>
          <button onClick={() => onDownload(img.dataUrl, nameOf(img, index))}>下载</button>
          {img.relPath && <button onClick={() => onRevealFile(img.relPath!)}>打开位置</button>}
          {img.fullPath && <button onClick={() => onCopyPath(img.fullPath!)}>复制路径</button>}
          <button onClick={() => onUseAsRef(img.dataUrl)}>用作参考图</button>
          <button className="close" onClick={onClose}>关闭 ✕</button>
        </div>
      </div>

      {images.length > 1 && (
        <>
          <button className="lb-nav prev" onClick={(e) => { e.stopPropagation(); step(-1) }}>‹</button>
          <button className="lb-nav next" onClick={(e) => { e.stopPropagation(); step(1) }}>›</button>
        </>
      )}

      <div
        className="lb-stage"
        onClick={(e) => e.stopPropagation()}
        onWheel={(e) => {
          e.preventDefault()
          setZoom((z) => Math.max(0.1, Math.min(8, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15))))
        }}
        onMouseDown={(e) => setDrag({ x: e.clientX - offset.x, y: e.clientY - offset.y })}
        onMouseMove={(e) => { if (drag) setOffset({ x: e.clientX - drag.x, y: e.clientY - drag.y }) }}
        onMouseUp={() => setDrag(null)}
        onMouseLeave={() => setDrag(null)}
        onDoubleClick={reset}
      >
        <img
          src={img.dataUrl}
          alt=""
          draggable={false}
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`, cursor: drag ? 'grabbing' : 'grab' }}
        />
      </div>

      {img.revisedPrompt && (
        <div className="lb-revised" onClick={(e) => e.stopPropagation()}>
          <strong>模型改写后的提示词：</strong> {img.revisedPrompt}
        </div>
      )}

      {img.fullPath && (
        <div className="lb-revised" onClick={(e) => e.stopPropagation()}>
          <strong>已保存到：</strong>{' '}
          <span
            style={{ cursor: 'pointer', textDecoration: 'underline dotted' }}
            onClick={() => onCopyPath(img.fullPath!)}
            title="点击复制路径"
          >
            {img.fullPath}
          </span>
        </div>
      )}
    </div>
  )
}
