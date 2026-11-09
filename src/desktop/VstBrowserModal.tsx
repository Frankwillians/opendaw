import { useEffect, useState } from 'react'
import { pluginApi, type NativePluginEntry } from './native'

interface VstBrowserModalProps {
  onPick: (path: string, name: string) => void
  onClose: () => void
}

export default function VstBrowserModal({
  onPick,
  onClose,
}: VstBrowserModalProps): React.JSX.Element {
  const [entries, setEntries] = useState<NativePluginEntry[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'all' | 'vst3' | 'vst2'>('all')

  const scan = () => {
    const api = pluginApi()
    if (!api) {
      setError('A API de plugins nativos não está disponível nesta janela.')
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    api
      .scan()
      .then((res) => {
        setLoading(false)
        if (!res.ok) {
          setError(res.error ?? 'Falha na varredura de plugins.')
        } else {
          const valid = (res.plugins ?? []).filter(
            (p) => !p.error && (p.kind === 'vst2' || p.kind === 'vst3'),
          )
          setEntries(valid)
        }
      })
      .catch((err: Error) => {
        setLoading(false)
        setError(err.message)
      })
  }

  useEffect(() => {
    scan()
  }, [])

  const handleAddFolder = async () => {
    const api = pluginApi()
    if (!api?.addDir) return
    const res = await api.addDir()
    if (!res.canceled && !res.error) {
      scan()
    }
  }

  const fileName = (p: string): string => p.split(/[\\/]/).pop() ?? p
  const entryName = (entry: NativePluginEntry): string => {
    if (entry.label) return entry.label.slice(0, 48)
    const klass =
      entry.meta?.classes?.find((item) => /^Audio/i.test(item.category ?? '')) ??
      entry.meta?.classes?.[0]
    const fromMeta = String(klass?.name ?? entry.meta?.module ?? '').trim()
    if (fromMeta) return fromMeta.slice(0, 48)
    return fileName(entry.path)
      .replace(/\.(vst3|dll|vst)$/i, '')
      .slice(0, 48)
  }
  const entryVendor = (entry: NativePluginEntry): string => {
    const info = entry.meta?.info as { vendor?: string } | undefined
    return String(entry.meta?.vendor ?? info?.vendor ?? '').trim().slice(0, 24)
  }

  const filtered = (entries ?? []).filter((item) => {
    if (tab === 'vst3' && item.kind !== 'vst3') return false
    if (tab === 'vst2' && item.kind !== 'vst2') return false
    if (!search.trim()) return true
    const q = search.toLowerCase()
    const name = entryName(item).toLowerCase()
    const vendor = entryVendor(item).toLowerCase()
    const path = item.path.toLowerCase()
    return name.includes(q) || vendor.includes(q) || path.includes(q)
  })

  const vst3Count = (entries ?? []).filter((e) => e.kind === 'vst3').length
  const vst2Count = (entries ?? []).filter((e) => e.kind === 'vst2').length

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="vst-browser-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="vst-browser-header">
          <div className="vst-browser-title">
            <span className="vst-icon">⚡</span>
            <span>PLUGINS VST / VST3 NATIVOS</span>
          </div>
          <button type="button" className="reaper-btn close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="vst-browser-toolbar">
          <div className="vst-search-box">
            <span className="search-icon">🔍</span>
            <input
              type="text"
              className="vst-search-input"
              placeholder="Buscar por nome, fabricante ou pasta…"
              value={search}
              autoFocus
              onChange={(e) => setSearch(e.target.value)}
            />
            {search ? (
              <button
                type="button"
                className="clear-search-btn"
                onClick={() => setSearch('')}
              >
                ✕
              </button>
            ) : null}
          </div>

          <div className="vst-tabs">
            <button
              type="button"
              className={`vst-tab ${tab === 'all' ? 'active' : ''}`}
              onClick={() => setTab('all')}
            >
              Todos ({(entries ?? []).length})
            </button>
            <button
              type="button"
              className={`vst-tab ${tab === 'vst3' ? 'active' : ''}`}
              onClick={() => setTab('vst3')}
            >
              VST3 ({vst3Count})
            </button>
            <button
              type="button"
              className={`vst-tab ${tab === 'vst2' ? 'active' : ''}`}
              onClick={() => setTab('vst2')}
            >
              VST2 ({vst2Count})
            </button>
          </div>

          <div className="vst-actions">
            <button
              type="button"
              className="reaper-btn mini"
              title="Adicionar uma pasta de plugins ao escaneamento"
              onClick={() => void handleAddFolder()}
            >
              + Pasta…
            </button>
            <button
              type="button"
              className="reaper-btn mini"
              title="Escanear novamente"
              onClick={scan}
              disabled={loading}
            >
              {loading ? 'Buscando…' : '🔄 Rescan'}
            </button>
          </div>
        </div>

        {error ? <div className="vst-browser-error">⚠ {error}</div> : null}

        <div className="vst-browser-list">
          {loading && !entries ? (
            <div className="vst-browser-empty">Carregando plugins instalados…</div>
          ) : filtered.length === 0 ? (
            <div className="vst-browser-empty">
              {search
                ? `Nenhum plugin encontrado para "${search}".`
                : 'Nenhum plugin VST encontrado no sistema.'}
            </div>
          ) : (
            filtered.map((item) => {
              const name = entryName(item)
              const vendor = entryVendor(item)
              const isVst3 = item.kind === 'vst3'
              return (
                <div
                  key={item.path}
                  className="vst-item-card"
                  onDoubleClick={() => onPick(item.path, name)}
                >
                  <div className="vst-item-main">
                    <span
                      className={`vst-kind-badge ${isVst3 ? 'vst3' : 'vst2'}`}
                    >
                      {item.kind.toUpperCase()}
                    </span>
                    <span className="vst-item-name">{name}</span>
                    {vendor ? <span className="vst-item-vendor">{vendor}</span> : null}
                  </div>
                  <div className="vst-item-path" title={item.path}>
                    {item.path}
                  </div>
                  <button
                    type="button"
                    className="reaper-btn primary mini vst-add-btn"
                    onClick={() => onPick(item.path, name)}
                  >
                    + Adicionar
                  </button>
                </div>
              )
            })
          )}
        </div>

        <div className="vst-browser-footer">
          <span>
            {filtered.length} plugin(s) disponível(is) · Clique duplo ou &quot;+ Adicionar&quot; para inserir na cadeia
          </span>
          <button type="button" className="reaper-btn" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  )
}
