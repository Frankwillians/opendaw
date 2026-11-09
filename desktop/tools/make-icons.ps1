# Recorta o fundo claro da imagem de referência do logo e exporta os tamanhos
# de ícone que o app, o exe e o instalador usam. O fundo é removido por flood
# fill a partir das bordas (só o que está conectado à borda some — o texto
# branco de dentro do quadrado fica intacto).
param(
  [string]$Src = $(Throw 'informe -Src'),
  [string]$OutDir = $(Throw 'informe -OutDir')
)
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap($Src)
$w = $bmp.Width; $h = $bmp.Height
$rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
$data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadWrite, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$stride = $data.Stride
$bytes = New-Object byte[] ($stride * $h)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)

function Test-Clear([int]$i) {
  # BGRA; fundo claro = os três canais altos
  return ($bytes[$i] -gt 150) -and ($bytes[$i + 1] -gt 150) -and ($bytes[$i + 2] -gt 150)
}

$stack = New-Object System.Collections.Generic.Stack[int]
for ($x = 0; $x -lt $w; $x++) {
  foreach ($y in @(0, ($h - 1))) {
    $i = $y * $stride + $x * 4
    if (Test-Clear $i) { $bytes[$i + 3] = 0; $stack.Push($i) }
  }
}
for ($y = 0; $y -lt $h; $y++) {
  foreach ($x in @(0, ($w - 1))) {
    $i = $y * $stride + $x * 4
    if (Test-Clear $i) { $bytes[$i + 3] = 0; $stack.Push($i) }
  }
}
while ($stack.Count -gt 0) {
  $i = $stack.Pop()
  $x = ($i % $stride) / 4
  $y = [math]::Floor($i / $stride)
  foreach ($n in @(($i - 4), ($i + 4), ($i - $stride), ($i + $stride))) {
    if ($n -lt 0 -or $n -ge $bytes.Length) { continue }
    $nx = ($n % $stride) / 4
    if ([math]::Abs($nx - $x) -gt 1) { continue }
    if ($bytes[$n + 3] -eq 0) { continue }
    if (Test-Clear $n) { $bytes[$n + 3] = 0; $stack.Push($n) }
  }
}

# bbox do que sobrou (o quadrado do logo)
$minX = $w; $minY = $h; $maxX = 0; $maxY = 0
for ($y = 0; $y -lt $h; $y++) {
  for ($x = 0; $x -lt $w; $x++) {
    if ($bytes[$y * $stride + $x * 4 + 3] -gt 0) {
      if ($x -lt $minX) { $minX = $x }
      if ($x -gt $maxX) { $maxX = $x }
      if ($y -lt $minY) { $minY = $y }
      if ($y -gt $maxY) { $maxY = $y }
    }
  }
}
[System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $data.Scan0, $bytes.Length)
$bmp.UnlockBits($data)
$cw = $maxX - $minX + 1; $ch = $maxY - $minY + 1
Write-Host "bbox: $minX,$minY ${cw}x${ch}"

$crop = New-Object System.Drawing.Bitmap($cw, $ch)
$g = [System.Drawing.Graphics]::FromImage($crop)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$dest = New-Object System.Drawing.Rectangle(0, 0, $cw, $ch)
$srcRect = New-Object System.Drawing.Rectangle($minX, $minY, $cw, $ch)
$g.DrawImage($bmp, $dest, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$crop.Save((Join-Path $OutDir 'master.png'), [System.Drawing.Imaging.ImageFormat]::Png)
foreach ($size in @(512, 256, 128, 64, 48, 32, 16)) {
  $out = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($out)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.DrawImage($crop, 0, 0, $size, $size)
  $g.Dispose()
  $out.Save((Join-Path $OutDir ("size-{0}.png" -f $size)), [System.Drawing.Imaging.ImageFormat]::Png)
  $out.Dispose()
}
$crop.Dispose(); $bmp.Dispose()
Write-Host 'ok'