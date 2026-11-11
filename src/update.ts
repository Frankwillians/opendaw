/**
 * Atualização do OpenDAW pela última release do GitHub.
 *
 * No executável instalado quem fala com o GitHub é o processo principal (ele tem
 * como baixar o Setup e entregá-lo ao Windows). No navegador a mesma consulta é
 * feita daqui — a API pública do GitHub manda CORS — e o que a página pode fazer
 * é abrir a página da release.
 */
import { nativeApi } from './desktop/native'
import type { NativeUpdateAsset, NativeUpdateCheck } from './desktop/native'

export type UpdateAsset = NativeUpdateAsset
export type UpdateCheck = NativeUpdateCheck

const REPO = 'Frankwillians/opendaw'
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`
const INSTALLER_NAME = /^OpenDAW-Setup-\d+\.\d+\.\d+\.exe$/i

/** A versão que está rodando: a mesma do package.json, injetada pelo Vite. */
export const appVersion: string = __APP_VERSION__

function versionParts(text: string): { numbers: number[]; pre: string } | null {
  const match = String(text || '')
    .trim()
    .replace(/^v/i, '')
    .match(/^(\d+)\.(\d+)\.(\d+)(?:[-+](.*))?$/)
  if (!match) return null
  return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] || '' }
}

/** -1, 0 ou 1: mesma conta do updater.cjs, para as duas pontas concordarem. */
export function compareVersions(a: string, b: string): number {
  const left = versionParts(a)
  const right = versionParts(b)
  if (!left || !right) return 0
  for (let index = 0; index < 3; index += 1) {
    if (left.numbers[index] !== right.numbers[index]) {
      return left.numbers[index] > right.numbers[index] ? 1 : -1
    }
  }
  if (left.pre === right.pre) return 0
  if (!left.pre) return 1
  if (!right.pre) return -1
  return left.pre > right.pre ? 1 : -1
}

function installerOf(assets: unknown): UpdateAsset | null {
  if (!Array.isArray(assets)) return null
  const setup = assets.find(
    (asset): asset is { name: string; size: number; browser_download_url: string } =>
      Boolean(
        asset &&
          INSTALLER_NAME.test(String(asset.name || '')) &&
          (!asset.state || asset.state === 'uploaded'),
      ),
  )
  if (!setup) return null
  return { name: setup.name, size: Number(setup.size) || 0, url: setup.browser_download_url }
}

async function checkInBrowser(force: boolean): Promise<UpdateCheck> {
  try {
    const response = await fetch(API_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: force ? 'no-store' : 'default',
    })
    if (!response.ok) {
      throw new Error(
        response.status === 403
          ? 'o GitHub recusou a consulta (limite por hora)'
          : `o GitHub respondeu ${response.status}`,
      )
    }
    const release = (await response.json()) as {
      tag_name?: string
      html_url?: string
      body?: string
      published_at?: string
      assets?: unknown
    }
    const latest = String(release.tag_name || '').replace(/^v/i, '') || appVersion
    return {
      ok: true,
      mode: 'web',
      current: appVersion,
      latest,
      newer: compareVersions(latest, appVersion) > 0,
      releaseUrl: release.html_url || RELEASES_URL,
      notes: typeof release.body === 'string' ? release.body.slice(0, 4000) : '',
      publishedAt: release.published_at || '',
      asset: installerOf(release.assets),
    }
  } catch (error) {
    return {
      ok: false,
      mode: 'web',
      current: appVersion,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Consulta a última release. No executável quem responde é o processo principal. */
export async function checkForUpdate(force = false): Promise<UpdateCheck> {
  const api = nativeApi()
  if (api?.updates) {
    try {
      return await api.updates.check({ force })
    } catch (error) {
      return {
        ok: false,
        mode: 'installed',
        current: appVersion,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
  return checkInBrowser(force)
}

/** Baixa o Setup. Só existe no executável: um navegador não roda instalador. */
export async function downloadUpdate(
  asset: UpdateAsset,
  onProgress: (progress: { received: number; total: number; percent: number }) => void,
): Promise<{ ok: boolean; path?: string; name?: string; error?: string }> {
  const api = nativeApi()
  if (!api?.updates) return { ok: false, error: 'a versão web não instala sozinha' }
  const stop = api.updates.onProgress(onProgress)
  try {
    return await api.updates.download(asset)
  } finally {
    stop()
  }
}

/** Fecha o app, roda o Setup em silêncio e reabre o OpenDAW no fim. */
export async function installUpdate(filePath: string): Promise<{ ok: boolean; error?: string }> {
  const api = nativeApi()
  if (!api?.updates) return { ok: false, error: 'a versão web não instala sozinha' }
  return api.updates.install(filePath)
}

/** Abre a página da release: o caminho da versão web e do portátil. */
export async function openReleasePage(url?: string): Promise<void> {
  const target = url && /^https:\/\/github\.com\/Frankwillians\/opendaw\//i.test(url) ? url : RELEASES_URL
  const api = nativeApi()
  if (api?.updates) {
    await api.updates.openRelease(target)
    return
  }
  window.open(target, '_blank', 'noopener,noreferrer')
}

/** Aviso de versão nova que o processo principal manda quando checa sozinho. */
export function onUpdateAvailable(handler: (info: UpdateCheck) => void): () => void {
  return nativeApi()?.updates?.onAvailable(handler) ?? (() => {})
}
