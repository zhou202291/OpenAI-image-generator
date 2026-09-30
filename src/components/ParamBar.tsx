import { useState } from 'react'
import type { GenParams, Settings } from '../types'
import { MODEL_PRESETS, QUALITY_LABELS, SIZE_CHOICES, presetOf } from '../types'

interface Props {
  params: GenParams
  api: Settings['api']
  onChange: (patch: Partial<GenParams>) => void
  disabled?: boolean
}

/**
 * 一个参数控件。
 *
 * ⚠️ 这里刻意用 <div> 而不是 <label> 包裹。
 * 之前用 <label> 包住 <select>，而高级面板里又嵌了一层 <label>，
 * 造成 label 嵌套 label —— HTML 规范不允许，浏览器会把点击事件
 * 转发给外层 label 关联的控件，导致「更多」里的下拉框完全点不动。
 * 所以：外层一律用 div，只有文字标签用 label 并通过 htmlFor 关联。
 */
function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="field" title={hint}>
      <span className="field-label">{label}</span>
      {children}
    </div>
  )
}

export default function ParamBar({ params, api, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false)
  const preset = presetOf(params.model)

  const modelOptions = (() => {
    const ids = new Set(MODEL_PRESETS.map((m) => m.id))
    const extra = (api.availableModels || []).filter((m) => /image|dall-e/i.test(m) && !ids.has(m))
    return [
      ...MODEL_PRESETS.map((m) => ({ id: m.id, label: m.label })),
      ...extra.map((id) => ({ id, label: id })),
    ]
  })()

  const sizeOptions = (() => {
    const supported = preset.sizes
    const all = SIZE_CHOICES.filter((s) => supported.includes(s.value) || supported.includes('自定义'))
    return all.length ? all : SIZE_CHOICES
  })()

  // 高级参数里非默认值的个数，显示在按钮角标上
  const advancedCount =
    (params.output_format !== 'png' ? 1 : 0) +
    (params.output_compression !== 100 && (params.output_format === 'jpeg' || params.output_format === 'webp') ? 1 : 0) +
    (params.moderation !== 'auto' ? 1 : 0) +
    (params.input_fidelity !== 'low' ? 1 : 0) +
    (params.stream ? 1 : 0)

  return (
    <div className="parambar">
      {/* ---------- 常用参数：始终平铺 ---------- */}
      <div className="parambar-main">
        <Field label="模型">
          <select
            value={params.model}
            onChange={(e) => {
              const id = e.target.value
              const p = presetOf(id)
              // 切换模型时把该模型不支持的参数拉回默认，避免 400
              const patch: Partial<GenParams> = { model: id }
              if (!p.qualities.includes(params.quality)) patch.quality = p.qualities.includes('auto') ? 'auto' : p.qualities[0]
              if (!p.sizes.includes(params.size) && !p.sizes.includes('自定义')) patch.size = p.sizes.includes('auto') ? 'auto' : p.sizes[0]
              if (!p.supportsBackground) patch.background = 'auto'
              if (!p.supportsOutputFormat) { patch.output_format = 'png'; patch.output_compression = 100 }
              if (!p.supportsModeration) patch.moderation = 'auto'
              if (!p.supportsInputFidelity) patch.input_fidelity = 'low'
              if (!p.supportsStream) { patch.stream = false; patch.partial_images = 0 }
              onChange(patch)
            }}
            disabled={disabled}
          >
            {modelOptions.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </Field>

        <Field label="画质" hint="高画质更精细，但更慢也更贵">
          <select value={params.quality} onChange={(e) => onChange({ quality: e.target.value })} disabled={disabled}>
            {preset.qualities.map((q) => (
              <option key={q} value={q}>{QUALITY_LABELS[q] || q}</option>
            ))}
          </select>
        </Field>

        <Field label="尺寸">
          <select value={params.size} onChange={(e) => onChange({ size: e.target.value })} disabled={disabled}>
            {sizeOptions.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
            {!sizeOptions.some((s) => s.value === params.size) && <option value={params.size}>{params.size}</option>}
          </select>
        </Field>

        <Field label="张数">
          <input
            type="number" min={1} max={10} value={params.n}
            onChange={(e) => onChange({ n: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })}
            disabled={disabled} className="num"
          />
        </Field>

        {preset.supportsBackground && (
          <Field label="背景" hint="透明背景需要配合 PNG 或 WebP">
            <select
              value={params.background}
              onChange={(e) => {
                const bg = e.target.value
                const patch: Partial<GenParams> = { background: bg }
                // 透明背景 + JPEG 是非法组合，自动切回 PNG
                if (bg === 'transparent' && params.output_format === 'jpeg') patch.output_format = 'png'
                onChange(patch)
              }}
              disabled={disabled}
            >
              <option value="auto">自动</option>
              <option value="opaque">不透明</option>
              <option value="transparent">透明</option>
            </select>
          </Field>
        )}

        <button
          type="button"
          className={`adv-toggle ${open ? 'open' : ''}`}
          onClick={() => setOpen((v) => !v)}
          title="展开/收起更多参数"
          aria-expanded={open}
        >
          <span>更多参数</span>
          <span className="chev">{open ? '▴' : '▾'}</span>
          {advancedCount > 0 && <span className="badge">{advancedCount}</span>}
        </button>
      </div>

      {/* ---------- 高级参数：点「更多参数」才展开 ---------- */}
      {open && (
        <div className="parambar-adv">
          {preset.supportsOutputFormat && (
            <>
              <Field label="输出格式" hint="透明背景只能用 PNG 或 WebP">
                <select
                  value={params.output_format}
                  onChange={(e) => {
                    const f = e.target.value
                    const patch: Partial<GenParams> = { output_format: f }
                    if (f === 'jpeg' && params.background === 'transparent') patch.background = 'auto'
                    onChange(patch)
                  }}
                  disabled={disabled}
                >
                  <option value="png">PNG · 无损可透明</option>
                  <option value="webp">WebP · 体积小</option>
                  <option value="jpeg">JPEG · 体积最小</option>
                </select>
              </Field>

              {(params.output_format === 'jpeg' || params.output_format === 'webp') && (
                <Field label={`压缩率 ${params.output_compression}%`} hint="越小体积越小，画质越低">
                  <input
                    type="range" min={0} max={100} value={params.output_compression}
                    onChange={(e) => onChange({ output_compression: Number(e.target.value) })}
                    disabled={disabled}
                  />
                </Field>
              )}
            </>
          )}

          {preset.supportsModeration && (
            <Field label="内容审核" hint="宽松会减少模型自动拦截">
              <select value={params.moderation} onChange={(e) => onChange({ moderation: e.target.value })} disabled={disabled}>
                <option value="auto">严格 · 默认</option>
                <option value="low">宽松</option>
              </select>
            </Field>
          )}

          {preset.supportsInputFidelity && (
            <Field label="参考图保真" hint="改图时越贴合原图">
              <select value={params.input_fidelity} onChange={(e) => onChange({ input_fidelity: e.target.value })} disabled={disabled}>
                <option value="low">低</option>
                <option value="high">高</option>
              </select>
            </Field>
          )}

          {preset.supportsStream && (
            <>
              <Field label="流式预览" hint="边画边显示草稿">
                <select value={params.stream ? 'on' : 'off'} onChange={(e) => onChange({ stream: e.target.value === 'on' })} disabled={disabled}>
                  <option value="off">关闭</option>
                  <option value="on">开启</option>
                </select>
              </Field>
              {params.stream && (
                <Field label="草稿帧数" hint="0-3 张中间预览图">
                  <input
                    type="number" min={0} max={3} value={params.partial_images}
                    onChange={(e) => onChange({ partial_images: Math.max(0, Math.min(3, Number(e.target.value) || 0)) })}
                    disabled={disabled} className="num"
                  />
                </Field>
              )}
            </>
          )}

          {preset.sizes.includes('自定义') && (
            <Field label="自定义尺寸" hint="宽高需为 16 的倍数，例如 1536x864">
              <input
                type="text" placeholder="1536x864"
                value={/^\d+x\d+$/.test(params.size) ? params.size : ''}
                onChange={(e) => onChange({ size: e.target.value })}
                disabled={disabled} className="txt"
              />
            </Field>
          )}

          {preset.note && <div className="adv-note">💡 {preset.note}</div>}
        </div>
      )}
    </div>
  )
}
