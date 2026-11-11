#!/usr/bin/env node
/**
 * Monta as duas entregas do GitHub sem tocar no OpenDAW que está em uso:
 *
 *   1. release/stage-app          — o app puro (o que vai dentro do instalador)
 *   2. release/OpenDAW-1.0.0-portable — pasta portátil com exe de ícone próprio
 *
 * O instalador NSIS sai depois, com `npx electron-builder --win nsis`, lendo
 * electron-builder.yml (directories.app aponta para o stage-app).
 *
 *   node desktop/build-release.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const DESKTOP = __dirname
const ROOT = path.join(DESKTOP, '..')
const ELECTRON_DIST = path.join(DESKTOP, 'node_modules', 'electron', 'dist')
const WEB_DIST = path.join(ROOT, 'dist')
const STAGE = path.join(ROOT, 'release', 'stage-app')
const manifest = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'))
const VERSION = manifest.version
// argv[2] troca a pasta de saída: a portátil em uso pelo produtor fica locked
// (o exe dela está rodando), então a entrega nova nasce em pasta separada.
const PORT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, 'release', `OpenDAW-${VERSION}-portable`)

const DESKTOP_FILES = [
  'main.cjs',
  'preload.cjs',
  'server.cjs',
  'plugins.cjs',
  'scan.cjs',
  'vst2.cjs',
  'vst3.cjs',
  'plugin-gui.cjs',
  'vst-worker.cjs',
  'wav.cjs',
  'portaudio.cjs',
  'asio-worker.cjs',
  'asio-host.cjs',
  'updater.cjs',
  'selftest-native.cjs',
]
const NATIVE_DEPS = ['koffi', '@koromix/koffi-win32-x64']

function fail(message) {
  console.error(`\nNÃO DÁ: ${message}\n`)
  process.exit(1)
}

function sizeMb(dir) {
  let bytes = 0
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else bytes += fs.statSync(full).size
    }
  }
  walk(dir)
  return (bytes / 1024 / 1024).toFixed(1)
}

/** O miolo do app: exatamente o que o Electron procura em resources/app. */
function buildStage() {
  fs.rmSync(STAGE, { recursive: true, force: true })
  fs.mkdirSync(path.join(STAGE, 'desktop'), { recursive: true })
  for (const file of DESKTOP_FILES) {
    const from = path.join(DESKTOP, file)
    if (!fs.existsSync(from)) fail(`falta desktop/${file}`)
    fs.copyFileSync(from, path.join(STAGE, 'desktop', file))
  }
  for (const file of ['icon.png', 'icon.ico']) {
    if (fs.existsSync(path.join(DESKTOP, file))) {
      fs.copyFileSync(path.join(DESKTOP, file), path.join(STAGE, 'desktop', file))
    }
  }
  fs.cpSync(path.join(DESKTOP, 'vendor'), path.join(STAGE, 'desktop', 'vendor'), { recursive: true })
  fs.mkdirSync(path.join(STAGE, 'node_modules'), { recursive: true })
  for (const dependency of NATIVE_DEPS) {
    const from = path.join(DESKTOP, 'node_modules', ...dependency.split('/'))
    if (!fs.existsSync(from)) fail(`falta desktop/node_modules/${dependency}`)
    fs.cpSync(from, path.join(STAGE, 'node_modules', ...dependency.split('/')), { recursive: true })
  }
  if (!fs.existsSync(path.join(WEB_DIST, 'index.html'))) fail('falta dist/. Rode npm run build na raiz.')
  fs.cpSync(WEB_DIST, path.join(STAGE, 'dist'), { recursive: true })
  fs.writeFileSync(
    path.join(STAGE, 'package.json'),
    `${JSON.stringify(
      {
        name: manifest.name,
        productName: manifest.productName,
        version: VERSION,
        description: manifest.description,
        main: 'desktop/main.cjs',
        type: 'commonjs',
        private: true,
        author: manifest.author,
        dependencies: { koffi: manifest.dependencies.koffi },
      },
      null,
      2,
    )}\n`,
  )
}

function buildPortable() {
  fs.rmSync(PORT, { recursive: true, force: true })
  fs.mkdirSync(PORT, { recursive: true })
  fs.cpSync(ELECTRON_DIST, PORT, {
    recursive: true,
    filter: (source) => !source.endsWith('default_app.asar'),
  })
  const exe = path.join(PORT, 'OpenDAW.exe')
  fs.renameSync(path.join(PORT, 'electron.exe'), exe)
  // A cópia do electron.exe não está em uso: pode receber ícone e versão.
  execFileSync(process.execPath, [path.join(DESKTOP, 'tools', 'patch-exe.cjs'), exe, path.join(DESKTOP, 'icon.ico'), VERSION], {
    stdio: 'inherit',
  })
  fs.cpSync(STAGE, path.join(PORT, 'resources', 'app'), { recursive: true })
}

function main() {
  if (!fs.existsSync(path.join(ELECTRON_DIST, 'electron.exe'))) fail('falta a distribuição do Electron. Rode npm install em desktop/.')
  console.log(`montando stage-app (${VERSION})`)
  buildStage()
  console.log(`montando ${PORT}`)
  buildPortable()
  console.log(`\nportátil pronto: ${path.join(PORT, 'OpenDAW.exe')} (${sizeMb(PORT)} MB)`)
  console.log(`stage do instalador: ${STAGE}`)
  console.log('instalador: cd desktop && npx electron-builder --win nsis --config electron-builder.yml')
}

main()