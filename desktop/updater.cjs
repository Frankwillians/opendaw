'use strict'
/**
 * Atualizador do OpenDAW.
 *
 * A fonte da verdade é a última release publicada no GitHub. O módulo só faz o
 * trabalho que precisa de processo: falar com a API, baixar o instalador e
 * entregá-lo ao Windows. Quem decide quando chamar é a interface.
 *
 * Garantias que valem a pena manter:
 *  - só aceita https, e só em hosts do GitHub;
 *  - só instala um arquivo cujo nome seja um instalador do OpenDAW;
 *  - a checagem automática é cacheada por horas (a API anônima tem limite de
 *    60 pedidos por hora por IP, e um app que abre dez vezes por dia estouraria
 *    esse limite à toa).
 */
const fs = require('node:fs')
const path = require('node:path')
const https = require('node:https')
const { spawn } = require('node:child_process')

const REPO = 'Frankwillians/opendaw'
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`
const USER_AGENT = 'OpenDAW-Updater/1.0'
const MAX_JSON_BYTES = 2 * 1024 * 1024
const MAX_INSTALLER_BYTES = 400 * 1024 * 1024
const CACHE_MS = 6 * 60 * 60 * 1000
const INSTALLER_NAME = /^OpenDAW-Setup-\d+\.\d+\.\d+\.exe$/i
const ALLOWED_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
])

/** Versões do app são `x.y.z`; qualquer sufixo depois disso ordena antes. */
function versionParts(text) {
  const clean = String(text || '').trim().replace(/^v/i, '')
  const match = clean.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+](.*))?$/)
  if (!match) return null
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] || '',
  }
}

/** -1, 0 ou 1: compara duas versões do app. */
function compareVersions(a, b) {
  const left = versionParts(a)
  const right = versionParts(b)
  if (!left || !right) return 0
  for (let index = 0; index < 3; index += 1) {
    if (left.numbers[index] !== right.numbers[index]) {
      return left.numbers[index] > right.numbers[index] ? 1 : -1
    }
  }
  // Uma pré-release (1.2.0-beta) vem antes da versão final (1.2.0).
  if (left.pre === right.pre) return 0
  if (!left.pre) return 1
  if (!right.pre) return -1
  return left.pre > right.pre ? 1 : -1
}

function assertGithubUrl(raw) {
  const url = new URL(String(raw || ''))
  if (url.protocol !== 'https:') throw new Error('o endereço da atualização não é https')
  if (!ALLOWED_HOSTS.has(url.hostname)) throw new Error(`host não permitido: ${url.hostname}`)
  return url
}

/** GET com no máximo cinco redirecionamentos, todos ainda em https/GitHub. */
function openStream(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' } },
      (response) => {
        const status = response.statusCode || 0
        if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
          response.resume()
          if (redirects >= 5) {
            reject(new Error('o GitHub redirecionou demais'))
            return
          }
          try {
            const next = assertGithubUrl(new URL(response.headers.location, url).href)
            openStream(next.href, redirects + 1).then(resolve, reject)
          } catch (error) {
            reject(error)
          }
          return
        }
        resolve(response)
      },
    )
    request.setTimeout(20000, () => request.destroy(new Error('o GitHub não respondeu a tempo')))
    request.on('error', reject)
  })
}

async function readJson(url) {
  const response = await openStream(url)
  if (response.statusCode !== 200) {
    response.resume()
    throw new Error(
      response.statusCode === 403
        ? 'o GitHub recusou o pedido (limite de consultas por hora)'
        : `o GitHub respondeu ${response.statusCode}`,
    )
  }
  const chunks = []
  let total = 0
  for await (const chunk of response) {
    total += chunk.length
    if (total > MAX_JSON_BYTES) throw new Error('a resposta do GitHub veio grande demais')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function readCache(cacheFile) {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
    if (!raw || typeof raw.at !== 'number' || !raw.result) return null
    return raw
  } catch {
    return null
  }
}

function writeCache(cacheFile, result) {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
    fs.writeFileSync(cacheFile, JSON.stringify({ at: Date.now(), result }))
  } catch {
    // Cache é conveniência: sem ele a próxima checagem só custa uma consulta.
  }
}

/** O instalador certo dentro da release: o Setup do Windows, nunca outro asset. */
function pickInstaller(assets) {
  const list = Array.isArray(assets) ? assets : []
  const setup = list.find(
    (asset) =>
      asset &&
      INSTALLER_NAME.test(String(asset.name || '')) &&
      (!asset.state || asset.state === 'uploaded'),
  )
  if (!setup) return null
  return {
    name: String(setup.name),
    size: Number(setup.size) || 0,
    url: String(setup.browser_download_url || ''),
  }
}

/**
 * Consulta a última release. `force` ignora o cache (botão "Verificar
 * atualizações"); a chamada automática usa o cache de 6 horas.
 */
async function check({ current, cacheFile, force = false, mode = 'installed' }) {
  const cached = cacheFile ? readCache(cacheFile) : null
  if (!force && cached && Date.now() - cached.at < CACHE_MS && cached.result.current === current) {
    return { ...cached.result, cached: true }
  }

  try {
    const release = await readJson(API_URL)
    const latest = String(release.tag_name || '').replace(/^v/i, '') || current
    const asset = pickInstaller(release.assets)
    const result = {
      ok: true,
      mode,
      current,
      latest,
      newer: compareVersions(latest, current) > 0,
      releaseUrl: release.html_url || RELEASES_URL,
      notes: typeof release.body === 'string' ? release.body.slice(0, 4000) : '',
      publishedAt: release.published_at || '',
      asset,
    }
    if (cacheFile) writeCache(cacheFile, result)
    return result
  } catch (error) {
    // Offline ou limite da API: uma resposta antiga ainda serve para avisar
    // que existe versão nova, desde que seja da mesma versão instalada.
    if (cached && cached.result.current === current) {
      return { ...cached.result, cached: true, stale: true, warning: error.message }
    }
    return {
      ok: false,
      mode,
      current,
      error: error.message,
    }
  }
}

function safeInstallerName(name) {
  const base = path.basename(String(name || ''))
  if (!INSTALLER_NAME.test(base)) throw new Error('o arquivo baixado não é um instalador do OpenDAW')
  return base
}

/** Baixa o Setup para uma pasta temporária, com progresso em bytes. */
async function download(asset, dir, onProgress = () => {}) {
  const name = safeInstallerName(asset?.name)
  const url = assertGithubUrl(asset?.url)
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, name)
  const partial = `${target}.part`
  fs.rmSync(partial, { force: true })

  const response = await openStream(url.href)
  if (response.statusCode !== 200) {
    response.resume()
    throw new Error(`o download respondeu ${response.statusCode}`)
  }
  const total = Number(response.headers['content-length']) || Number(asset.size) || 0
  if (total > MAX_INSTALLER_BYTES) throw new Error('o instalador veio maior que o esperado')

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(partial)
    let received = 0
    let lastSent = 0
    response.on('data', (chunk) => {
      received += chunk.length
      const now = Date.now()
      if (now - lastSent > 120) {
        lastSent = now
        onProgress({
          received,
          total,
          percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0,
        })
      }
    })
    response.on('error', reject)
    out.on('error', reject)
    out.on('finish', () => {
      if (total > 0 && received !== total) {
        reject(new Error(`o download parou em ${received} de ${total} bytes`))
        return
      }
      onProgress({ received, total, percent: 100 })
      resolve()
    })
    response.pipe(out)
  })

  fs.rmSync(target, { force: true })
  fs.renameSync(partial, target)
  return target
}

/** Só entrega ao Windows um caminho que seja mesmo um instalador baixado. */
function validateInstaller(filePath) {
  const resolved = path.resolve(String(filePath || ''))
  if (!INSTALLER_NAME.test(path.basename(resolved))) {
    throw new Error('o arquivo não é um instalador do OpenDAW')
  }
  const stat = fs.statSync(resolved)
  if (!stat.isFile() || stat.size < 1024 * 1024) throw new Error('o instalador baixado está incompleto')
  return resolved
}

/**
 * O app precisa fechar para o NSIS substituir o OpenDAW.exe. O instalador roda
 * silencioso e, quando termina, o próprio OpenDAW volta — por um .bat porque o
 * cmd é o único jeito confiável de encadear "espere o instalador" e "abra o app".
 */
function launchInstaller(installerPath, appExePath) {
  const installer = validateInstaller(installerPath)
  const dir = path.dirname(installer)
  const script = path.join(dir, 'opendaw-update.bat')
  const lines = [
    '@echo off',
    'timeout /t 2 /nobreak >nul',
    `"${installer}" /S`,
    `if exist "${appExePath}" start "" "${appExePath}"`,
  ]
  fs.writeFileSync(script, `${lines.join('\r\n')}\r\n`)
  const child = spawn('cmd.exe', ['/d', '/s', '/c', script], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  return script
}

module.exports = {
  REPO,
  RELEASES_URL,
  INSTALLER_NAME,
  compareVersions,
  versionParts,
  check,
  download,
  validateInstaller,
  launchInstaller,
}
