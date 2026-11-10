#!/usr/bin/env node
/**
 * Gera desktop/icon.ico a partir de desktop/icon.png (256x256 RGBA).
 *
 * ICO multi-tamanho: 256 em PNG embutido (Vista+) e 16/24/32/48/64 em BMP
 * BGRA com downsample por média de área — o que o resedit (patch-exe) e o
 * electron-builder esperam. Sem dependências: node desktop/tools/make-ico.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const DESKTOP = path.join(__dirname, '..')
const SRC = path.join(DESKTOP, 'icon.png')
const OUT = path.join(DESKTOP, 'icon.ico')

// --- decodifica o PNG RGBA escrito por make-icon.cjs ---
const png = fs.readFileSync(SRC)
if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('icon.png não é PNG')
let width = 0
let height = 0
let bitDepth = 0
let colorType = 0
const idat = []
let offset = 8
while (offset < png.length) {
  const len = png.readUInt32BE(offset)
  const type = png.toString('latin1', offset + 4, offset + 8)
  const body = png.subarray(offset + 8, offset + 8 + len)
  if (type === 'IHDR') {
    width = body.readUInt32BE(0)
    height = body.readUInt32BE(4)
    bitDepth = body[8]
    colorType = body[9]
  } else if (type === 'IDAT') {
    idat.push(body)
  }
  offset += 12 + len
}
if (bitDepth !== 8 || colorType !== 6) throw new Error(`PNG inesperado: depth=${bitDepth} color=${colorType}`)
const raw = zlib.inflateSync(Buffer.concat(idat))
const stride = width * 4
const px = Buffer.alloc(width * height * 4)
for (let y = 0; y < height; y += 1) {
  const filter = raw[y * (stride + 1)]
  const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
  const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null
  const cur = px.subarray(y * stride, (y + 1) * stride)
  for (let x = 0; x < stride; x += 1) {
    const a = x >= 4 ? cur[x - 4] : 0
    const b = prev ? prev[x] : 0
    const c = prev && x >= 4 ? prev[x - 4] : 0
    let value = row[x]
    if (filter === 1) value += a
    else if (filter === 2) value += b
    else if (filter === 3) value += (a + b) >> 1
    else if (filter === 4) {
      const p = a + b - c
      const pa = Math.abs(p - a)
      const pb = Math.abs(p - b)
      const pc = Math.abs(p - c)
      value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
    }
    cur[x] = value & 0xff
  }
}

// --- downsample por média de área (RGBA) ---
function resize(size) {
  const out = Buffer.alloc(size * size * 4)
  const ratio = width / size
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const x0 = Math.floor(x * ratio)
      const y0 = Math.floor(y * ratio)
      const x1 = Math.min(width, Math.max(x0 + 1, Math.floor((x + 1) * ratio)))
      const y1 = Math.min(height, Math.max(y0 + 1, Math.floor((y + 1) * ratio)))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const i = (sy * width + sx) * 4
          const alpha = px[i + 3]
          r += px[i] * alpha
          g += px[i + 1] * alpha
          b += px[i + 2] * alpha
          a += alpha
          n += 1
        }
      }
      const o = (y * size + x) * 4
      if (a > 0) {
        out[o] = Math.round(r / a)
        out[o + 1] = Math.round(g / a)
        out[o + 2] = Math.round(b / a)
      }
      out[o + 3] = Math.round(a / n)
    }
  }
  return out
}

// --- imagem BMP (BITMAPINFOHEADER + BGRA de baixo para cima + máscara AND) ---
function bmpImage(size, rgba) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8) // XOR + AND
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  const xor = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const s = ((size - 1 - y) * size + x) * 4
      const d = (y * size + x) * 4
      xor[d] = rgba[s + 2]
      xor[d + 1] = rgba[s + 1]
      xor[d + 2] = rgba[s]
      xor[d + 3] = rgba[s + 3]
    }
  }
  const andStride = Math.ceil(size / 32) * 4
  const andMask = Buffer.alloc(andStride * size) // zeros: usa o alfa do XOR
  return Buffer.concat([header, xor, andMask])
}

const sizes = [16, 24, 32, 48, 64, 256]
const images = sizes.map((size) => (size === 256 ? png : bmpImage(size, resize(size))))
const dir = Buffer.alloc(6 + sizes.length * 16)
dir.writeUInt16LE(0, 0)
dir.writeUInt16LE(1, 2) // tipo ICO
dir.writeUInt16LE(sizes.length, 4)
let dataOffset = dir.length
sizes.forEach((size, index) => {
  const e = 6 + index * 16
  dir[e] = size === 256 ? 0 : size
  dir[e + 1] = size === 256 ? 0 : size
  dir.writeUInt16LE(1, e + 4)
  dir.writeUInt16LE(32, e + 6)
  dir.writeUInt32LE(images[index].length, e + 8)
  dir.writeUInt32LE(dataOffset, e + 12)
  dataOffset += images[index].length
})
fs.writeFileSync(OUT, Buffer.concat([dir, ...images]))
console.log(`ícone escrito em ${OUT} (${sizes.join(', ')} px)`)