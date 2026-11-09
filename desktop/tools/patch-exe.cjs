#!/usr/bin/env node
/**
 * Troca o ícone e a versão de um executável Windows sem compilador nenhum:
 * o resedit (JS puro, dependência do electron-builder) reescreve os recursos
 * RT_ICON / RT_GROUP_ICON e o VERSIONINFO do PE. Usado no exe portátil, que é
 * uma cópia do electron.exe — a cópia não está em uso, então pode ser editada.
 *
 *   node desktop/tools/patch-exe.cjs <exe> <ico> <versão>
 */
const fs = require('node:fs')
const resedit = require('resedit')

const [exePath, icoPath, version] = process.argv.slice(2)
if (!exePath || !icoPath || !version) {
  console.error('uso: patch-exe.cjs <exe> <ico> <versão>')
  process.exit(1)
}

const executable = resedit.NtExecutable.from(fs.readFileSync(exePath))
const resource = resedit.NtExecutableResource.from(executable)

// O ícone padrão do Electron sai inteiro (grupo + imagens) antes do nosso entrar.
resource.entries = resource.entries.filter((e) => e.type !== 3 && e.type !== 14)
const iconFile = resedit.Data.IconFile.from(fs.readFileSync(icoPath))
resedit.Resource.IconGroupEntry.replaceIconsForResource(
  resource.entries,
  1,
  1033,
  iconFile.icons.map((item) => item.data),
)

const infos = resedit.Resource.VersionInfo.fromEntries(resource.entries)
if (infos.length !== 1) throw new Error(`VERSIONINFO inesperado em ${exePath}`)
const info = infos[0]
const [major, minor, patch] = version.split('.').map((n) => parseInt(n, 10) || 0)
const ms = (major << 16) | minor
const ls = (patch << 16) | 0
info.fixedInfo.fileVersionMS = ms
info.fixedInfo.fileVersionLS = ls
info.fixedInfo.productVersionMS = ms
info.fixedInfo.productVersionLS = ls
const lang = info.getAllLanguagesForStringValues()[0]
info.setStringValues(lang, {
  CompanyName: 'OpenDAW',
  FileDescription: 'OpenDAW — estúdio de gravação e mixagem',
  FileVersion: version,
  InternalName: 'OpenDAW',
  OriginalFilename: 'OpenDAW.exe',
  ProductName: 'OpenDAW',
  ProductVersion: version,
})
info.outputToResourceEntries(resource.entries)

resource.outputResource(executable)
fs.writeFileSync(exePath, Buffer.from(executable.generate()))
console.log(`ícone + versão ${version} aplicados em ${exePath}`)