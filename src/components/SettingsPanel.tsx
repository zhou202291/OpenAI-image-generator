import { useEffect, useState } from 'react'
import type { Settings } from '../types'
import { probe, fetchModels, getConfig, setImageDir, revealImageDir, clearAllSessions, type ProbeResult, type RuntimeConfig, type SetImageDirResult } from '../api'

/** 把换位置的结果描述成一句人话 */
function describeMove(r: SetImageDirResult): string {
  const where = `已改为 ${r.imageDir}`
  if (r.moveError) {
    return `${where}。⚠ 老图片搬迁失败（${r.moveError}），历史对话里的图可能显示不出来`
  }
  const moved = r.moved || 0
  const skipped = r.skipped || 0
  if (moved === 0 && skipped === 0) return `${where}（原有目录没有图片）`
  let s = `${where}，已搬迁 ${moved} 张图片`
  if (skipped) s += `，${skipped} 个同名文件已跳过`
  return s
}

interface Props {
  api: Settings['api']
  patchApi: (patch: Partial<Settings['api']>) => void
  maxSessions: number
  setMaxSessions: (n: number) => void
  runtimeCfg: RuntimeConfig | null
  onConfigChanged: (cfg: RuntimeConfig) => void
  onClose: () => void
}

export default function SettingsPanel({
  api, patchApi, maxSessions, setMaxSessions, runtimeCfg, onConfigChanged, onClose,
}: Props) {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<ProbeResult | null>(null)
  const [showKey, setShowKey] = useState(false)

  /* ---------- 图片保存位置 ---------- */
  const [dirInput, setDirInput] = useState('')
  const [dirBusy, setDirBusy] = useState(false)
  const [dirMsg, setDirMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    if (runtimeCfg) setDirInput(runtimeCfg.imageDirRelative)
  }, [runtimeCfg])

  /** 换位置时是否把老图片一起搬过去 */
  const [dirMove, setDirMove] = useState(true)

  const applyDir = async () => {
    if (!dirInput.trim()) return
    setDirBusy(true)
    setDirMsg(null)
    const r = await setImageDir(dirInput.trim(), dirMove)
    if (r.ok) {
      const cfg = await getConfig()
      if (cfg) onConfigChanged(cfg)
      setDirMsg({ ok: true, text: describeMove(r) })
    } else {
      setDirMsg({ ok: false, text: r.error || '修改失败' })
    }
    setDirBusy(false)
    setTimeout(() => setDirMsg(null), 6000)
  }

  const runTest = async () => {
    setTesting(true)
    setResult(null)
    const r = await probe(api)
    setResult(r)
    if (r.ok) {
      try {
        const models = await fetchModels(api)
        patchApi({ availableModels: models, modelsFetchedAt: Date.now() })
      } catch {
        /* 忽略 */
      }
    }
    setTesting(false)
  }

  const pullModels = async () => {
    setTesting(true)
    setResult(null)
    try {
      const models = await fetchModels(api)
      patchApi({ availableModels: models, modelsFetchedAt: Date.now() })
      setResult({ ok: true, title: `拉取到 ${models.length} 个模型`, detail: models.slice(0, 8).join('、') + (models.length > 8 ? ' …' : '') })
    } catch (e: any) {
      setResult({ ok: false, title: `拉取失败：${e.detail || e.message}`, detail: e.hint || '' })
    }
    setTesting(false)
  }

  const imageModels = (api.availableModels || []).filter((m) => /image|dall-e/i.test(m))

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>设置</h2>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </header>

        <div className="modal-body">
          <section>
            <h3>接口连接</h3>

            <label className="set-field">
              <span>Base URL</span>
              <input
                type="text"
                value={api.baseUrl}
                spellCheck={false}
                placeholder="https://api.openai.com/v1"
                onChange={(e) => patchApi({ baseUrl: e.target.value })}
              />
              <em>填到 <code>/v1</code> 为止即可，程序会自动拼接 <code>/images/generations</code>。</em>
            </label>

            <label className="set-field">
              <span>API Key</span>
              <div className="key-row">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={api.apiKey}
                  spellCheck={false}
                  placeholder="sk-..."
                  onChange={(e) => patchApi({ apiKey: e.target.value })}
                />
                <button type="button" className="icon-btn" onClick={() => setShowKey((v) => !v)} title={showKey ? '隐藏' : '显示'}>
                  {showKey ? '🙈' : '👁'}
                </button>
              </div>
              <em>只保存在你本机浏览器的 localStorage 里，不会上传到任何服务器。</em>
            </label>

            <div className="btn-row">
              <button className="primary" onClick={runTest} disabled={testing}>
                {testing ? '测试中…' : '测试连接'}
              </button>
              <button onClick={pullModels} disabled={testing}>拉取模型列表</button>
            </div>

            {result && (
              <div className={`probe ${result.ok ? 'ok' : 'bad'}`}>
                <strong>{result.ok ? '✓ ' : '✕ '}{result.title}</strong>
                {result.detail && <p>{result.detail}</p>}
              </div>
            )}

            {imageModels.length > 0 && (
              <div className="model-chips">
                <span className="chips-label">可用生图模型：</span>
                {imageModels.map((m) => (
                  <button key={m} className="chip" onClick={() => patchApi({})} title="在下方参数栏的「模型」里选择">
                    {m}
                  </button>
                ))}
              </div>
            )}
          </section>

          <section>
            <h3>存储</h3>

            <div className="set-field">
              <span>图片保存位置</span>
              <div className="key-row">
                <input
                  type="text"
                  value={dirInput}
                  spellCheck={false}
                  placeholder="./image"
                  onChange={(e) => setDirInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') applyDir() }}
                />
                <button type="button" className="mini-btn" onClick={applyDir} disabled={dirBusy}>
                  {dirBusy ? '…' : '应用'}
                </button>
              </div>
              <em>
                默认 <code>./image</code>，即项目目录下的 image 文件夹，整个项目拷走也能直接用。
                也可以填 <code>D:\我的图片</code> 这样的绝对路径。
              </em>

              <label className="set-check">
                <input
                  type="checkbox"
                  checked={dirMove}
                  onChange={(e) => setDirMove(e.target.checked)}
                />
                <span>把已生成的图片一起搬过去（建议勾选，否则历史对话里的图会显示不出来）</span>
              </label>
              {runtimeCfg && (
                <em>
                  当前实际位置：<code>{runtimeCfg.imageDir}</code>
                </em>
              )}
              {dirMsg && (
                <div className={`probe ${dirMsg.ok ? 'ok' : 'bad'}`} style={{ marginTop: 8 }}>
                  {dirMsg.ok ? '✓ ' : '✕ '}{dirMsg.text}
                </div>
              )}
            </div>

            <div className="btn-row">
              <button onClick={async () => {
                const ok = await revealImageDir()
                if (!ok) setDirMsg({ ok: false, text: '无法打开目录，请确认启动服务仍在运行' })
              }}>在文件管理器中打开</button>
              {runtimeCfg && dirInput !== runtimeCfg.imageDirRelative && (
                <button onClick={() => setDirInput(runtimeCfg.imageDirRelative)}>恢复默认</button>
              )}
            </div>
          </section>

          <section>
            <h3>高级</h3>

            <label className="set-field">
              <span>附加请求头（JSON）</span>
              <textarea
                rows={3}
                spellCheck={false}
                value={api.extraHeaders}
                placeholder={'{"X-Custom-Header": "value"}'}
                onChange={(e) => patchApi({ extraHeaders: e.target.value })}
              />
              <em>一般留空。某些中转站要求额外校验头时才会用到。</em>
            </label>

            <label className="set-field">
              <span>请求超时（秒）</span>
              <input
                type="number" min={10} max={900}
                value={Math.round((api.timeoutMs || 300000) / 1000)}
                onChange={(e) => patchApi({ timeoutMs: Math.max(10, Math.min(900, Number(e.target.value) || 300)) * 1000 })}
              />
              <em>高画质生图可能要 1-3 分钟，建议不低于 180 秒。</em>
            </label>

            <label className="set-field">
              <span>最多保留会话数</span>
              <input
                type="number" min={5} max={200}
                value={maxSessions}
                onChange={(e) => setMaxSessions(Math.max(5, Math.min(200, Number(e.target.value) || 40)))}
              />
              <em>对话记录存在项目里的 data/sessions.json，可以放心调大。</em>
            </label>
          </section>

          <section>
            <h3>数据管理</h3>
            <div className="btn-row">
              <button className="danger" onClick={async () => {
                if (!confirm('确定要清空所有对话记录吗？\n\n图片文件不会被删除，仍然留在 image 目录里。')) return
                await clearAllSessions()
                location.reload()
              }}>清空全部对话</button>
            </div>
            <em style={{ display: 'block', marginTop: 8 }}>
              只清除 <code>data/sessions.json</code> 里的对话记录，<code>image</code> 目录里的图片不受影响。
            </em>
          </section>
        </div>
      </div>
    </div>
  )
}
