import { useCallback, useEffect, useRef, useState } from 'react'
import {
  appVersion,
  checkForUpdate,
  downloadUpdate,
  installUpdate,
  openReleasePage,
  type UpdateAsset,
  type UpdateCheck,
} from './update'

type Phase = 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'error'

interface Props {
  onClose: () => void
}

function formatSize(bytes: number): string {
  if (!bytes) return ''
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** As primeiras linhas da release, sem markdown de título nem linhas vazias. */
function summaryOf(notes: string | undefined): string[] {
  if (!notes) return []
  return notes
    .split(/\r?\n/)
    .map((line) => line.replace(/^#{1,6}\s*/, '').replace(/\*\*/g, '').trim())
    .filter(Boolean)
    .slice(0, 6)
}

/**
 * Janela de atualização. Consulta a última release do GitHub ao abrir e, no
 * executável instalado, baixa o Setup e o entrega ao Windows — o app fecha,
 * instala em silêncio e volta já na versão nova. Na web e na pasta portátil a
 * única saída é abrir a página da release.
 */
export function UpdateDialog({ onClose }: Props) {
  const [phase, setPhase] = useState<Phase>('checking')
  const [info, setInfo] = useState<UpdateCheck | null>(null)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')
  const [installerPath, setInstallerPath] = useState('')
  const [installing, setInstalling] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const runCheck = useCallback(async (force: boolean) => {
    setPhase('checking')
    setError('')
    const result = await checkForUpdate(force)
    if (!alive.current) return
    setInfo(result)
    if (!result.ok) {
      setError(result.error || 'não foi possível consultar o GitHub')
      setPhase('error')
      return
    }
    setPhase(result.newer ? 'available' : 'current')
  }, [])

  useEffect(() => {
    void runCheck(true)
  }, [runCheck])

  const startDownload = async () => {
    const asset: UpdateAsset | undefined = info?.asset ?? undefined
    if (!asset) return
    setPhase('downloading')
    setProgress(0)
    setError('')
    const result = await downloadUpdate(asset, (tick) => {
      if (alive.current) setProgress(tick.percent)
    })
    if (!alive.current) return
    if (!result.ok || !result.path) {
      setError(result.error || 'o download falhou')
      setPhase('error')
      return
    }
    setInstallerPath(result.path)
    setPhase('ready')
  }

  const applyUpdate = async () => {
    if (!installerPath) return
    setInstalling(true)
    const result = await installUpdate(installerPath)
    if (!result.ok) {
      setInstalling(false)
      setError(result.error || 'não foi possível iniciar o instalador')
      setPhase('error')
    }
    // Quando dá certo o app fecha sozinho, então não há estado para limpar.
  }

  const canInstall = info?.mode === 'installed' && Boolean(info.asset)
  const needsLink = info?.mode === 'portable' || info?.mode === 'web' || (info?.newer && !info.asset)
  const summary = summaryOf(info?.notes)

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="fx-window update-window" onClick={(event) => event.stopPropagation()}>
        <div className="fx-header">
          <span>Atualizações</span>
          <button type="button" className="reaper-btn" onClick={onClose} title="Fechar">
            X
          </button>
        </div>

        <div className="update-body">
          <div className="update-versions">
            <span>
              Instalada <strong>v{appVersion}</strong>
            </span>
            {info?.latest ? (
              <span>
                GitHub <strong>v{info.latest}</strong>
              </span>
            ) : null}
          </div>

          {phase === 'checking' ? (
            <div className="update-status">
              <span className="update-spinner" aria-hidden="true" />
              Consultando a última versão no GitHub…
            </div>
          ) : null}

          {phase === 'current' ? (
            <div className="update-status">
              <strong>Você está na versão mais recente.</strong>
              <span className="update-hint">
                O OpenDAW confere sozinho a cada abertura; este botão força a consulta.
              </span>
            </div>
          ) : null}

          {phase === 'available' ? (
            <div className="update-status">
              <strong>Versão {info?.latest} disponível.</strong>
              {summary.length > 0 ? (
                <ul className="update-notes">
                  {summary.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : null}
              {needsLink ? (
                <span className="update-hint">
                  {info?.mode === 'portable'
                    ? 'Esta é a pasta portátil: baixe a versão nova pela página da release.'
                    : info?.asset
                      ? 'A versão web não instala nada: baixe pela página da release.'
                      : 'A release não traz um instalador para o Windows.'}
                </span>
              ) : null}
              {canInstall ? (
                <span className="update-hint">
                  O instalador é baixado do GitHub ({formatSize(info?.asset?.size ?? 0)}). O OpenDAW
                  fecha para instalar e volta sozinho. Salve o projeto antes se quiser garantia.
                </span>
              ) : null}
            </div>
          ) : null}

          {phase === 'downloading' ? (
            <div className="update-status">
              <strong>Baixando o instalador… {progress}%</strong>
              <div className="update-progress" role="progressbar" aria-valuenow={progress}>
                <div className="update-bar" style={{ width: `${progress}%` }} />
              </div>
              <span className="update-hint">Pode continuar trabalhando enquanto baixa.</span>
            </div>
          ) : null}

          {phase === 'ready' ? (
            <div className="update-status">
              <strong>Instalador pronto.</strong>
              <span className="update-hint">
                {info?.latest} será instalada agora. O OpenDAW fecha, o instalador roda em silêncio
                e o app volta sozinho na versão nova.
              </span>
            </div>
          ) : null}

          {phase === 'error' ? (
            <div className="update-status update-error">
              <strong>Não deu para atualizar.</strong>
              <span className="update-hint">{error}</span>
            </div>
          ) : null}

          <div className="update-actions">
            <button type="button" className="reaper-btn" onClick={() => void runCheck(true)}>
              Verificar de novo
            </button>
            <span className="update-spacer" />
            {needsLink && info?.newer ? (
              <button
                type="button"
                className="reaper-btn highlight"
                onClick={() => void openReleasePage(info?.releaseUrl)}
              >
                Abrir página da versão
              </button>
            ) : null}
            {canInstall && phase === 'available' ? (
              <button type="button" className="reaper-btn highlight" onClick={() => void startDownload()}>
                Baixar e instalar {info?.latest}
              </button>
            ) : null}
            {phase === 'ready' ? (
              <button
                type="button"
                className="reaper-btn highlight"
                disabled={installing}
                onClick={() => void applyUpdate()}
              >
                {installing ? 'Instalando…' : 'Instalar agora'}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
