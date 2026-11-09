# Desenha o ícone do OpenDAW em vetor (GDI+), baseado na imagem de referência:
# telha escura, "Open" branco com play verde dentro do O, "DAW" em gradiente
# verde→azul e waveform arco-íris com barras de EQ embaixo. Vetor = limpo em
# 1024 e ainda limpo depois de reduzido a 16px, sem foto borrada no meio.
param([string]$Out = $(Throw 'informe -Out'))
Add-Type -AssemblyName System.Drawing
$S = 1024
$bmp = New-Object System.Drawing.Bitmap($S, $S)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear([System.Drawing.Color]::Transparent)
$fmt = [System.Drawing.StringFormat]::GenericTypographic

# telha escura com canto arredondado
$tile = New-Object System.Drawing.Drawing2D.GraphicsPath
$r = 190
$tile.AddArc(8, 8, $r * 2, $r * 2, 180, 90)
$tile.AddArc($S - 8 - $r * 2, 8, $r * 2, $r * 2, 270, 90)
$tile.AddArc($S - 8 - $r * 2, $S - 8 - $r * 2, $r * 2, $r * 2, 0, 90)
$tile.AddArc(8, $S - 8 - $r * 2, $r * 2, $r * 2, 90, 90)
$tile.CloseFigure()
$tileBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point(0, 0)), (New-Object System.Drawing.Point(0, $S)),
  [System.Drawing.Color]::FromArgb(255, 38, 42, 47), [System.Drawing.Color]::FromArgb(255, 14, 16, 19))
$g.FillPath($tileBrush, $tile)

# wordmark: anel-play + "pen" + "DAW", tudo medido em pixels
$font = New-Object System.Drawing.Font('Segoe UI', 150, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$box = New-Object System.Drawing.SizeF(2000, 2000)
$penSize = $g.MeasureString('pen', $font, $box, $fmt)
$dawSize = $g.MeasureString('DAW', $font, $box, $fmt)
$ringD = 175
$gap = 14
$total = $ringD + $gap + $penSize.Width + $gap + $dawSize.Width
$x = ($S - $total) / 2
$cy = 400
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 245, 247, 250))
# anel branco (o O)
$ringPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 245, 247, 250), 40)
$g.DrawEllipse($ringPen, $x + 20, $cy - $ringD / 2 + 20, $ringD - 40, $ringD - 40)
# play verde dentro do anel
$cx = $x + $ringD / 2
$play = New-Object System.Drawing.Drawing2D.GraphicsPath
$play.AddPolygon(@(
  (New-Object System.Drawing.PointF(($cx - 24), ($cy - 40))),
  (New-Object System.Drawing.PointF(($cx - 24), ($cy + 40))),
  (New-Object System.Drawing.PointF(($cx + 44), $cy))
))
$g.FillPath((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 34, 197, 94))), $play)
# "pen" branco
$tx = $x + $ringD + $gap
$g.DrawString('pen', $font, $white, $tx, $cy - 105, $fmt)
# "DAW" gradiente verde→azul
$dx = $tx + $penSize.Width + $gap
$dawBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.RectangleF($dx, 0, $dawSize.Width, 1)),
  [System.Drawing.Color]::FromArgb(255, 52, 211, 153), [System.Drawing.Color]::FromArgb(255, 56, 132, 255),
  [System.Drawing.Drawing2D.LinearGradientMode]::Horizontal)
$g.DrawString('DAW', $font, $dawBrush, $dx, $cy - 105, $fmt)

# waveform arco-íris
$wy = 680
$waveBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.RectangleF(90, 0, 844, 1)),
  [System.Drawing.Color]::FromArgb(255, 52, 211, 153), [System.Drawing.Color]::FromArgb(255, 56, 189, 248),
  [System.Drawing.Drawing2D.LinearGradientMode]::Horizontal)
$blend = New-Object System.Drawing.Drawing2D.ColorBlend
$blend.Colors = @(
  [System.Drawing.Color]::FromArgb(255, 52, 211, 153),
  [System.Drawing.Color]::FromArgb(255, 251, 146, 60),
  [System.Drawing.Color]::FromArgb(255, 232, 121, 249),
  [System.Drawing.Color]::FromArgb(255, 167, 139, 250),
  [System.Drawing.Color]::FromArgb(255, 56, 189, 248))
$blend.Positions = @(0.0, 0.28, 0.52, 0.74, 1.0)
$waveBrush.InterpolationColors = $blend
$wavePen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 14)
$wavePen.Brush = $waveBrush
$wavePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$wavePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$wave = New-Object System.Drawing.Drawing2D.GraphicsPath
$wave.AddBezier(90, $wy, 150, $wy, 170, $wy - 55, 220, $wy - 55)
$wave.AddBezier(220, $wy - 55, 265, $wy - 55, 275, $wy + 65, 320, $wy + 65)
$wave.AddBezier(320, $wy + 65, 365, $wy + 65, 375, $wy - 90, 420, $wy - 90)
$wave.AddBezier(420, $wy - 90, 465, $wy - 90, 475, $wy + 50, 520, $wy + 50)
$wave.AddBezier(520, $wy + 50, 565, $wy + 50, 575, $wy - 38, 620, $wy - 38)
$wave.AddBezier(620, $wy - 38, 665, $wy - 38, 675, $wy + 80, 720, $wy + 80)
$wave.AddBezier(720, $wy + 80, 765, $wy + 80, 775, $wy - 65, 820, $wy - 65)
$wave.AddBezier(820, $wy - 65, 865, $wy - 65, 880, $wy, 934, $wy)
$g.DrawPath($wavePen, $wave)

# barras de EQ (segmentos empilhados) em cinco colunas, cruzando a waveform
$cols = @(
  @{ x = 452; c = [System.Drawing.Color]::FromArgb(255, 251, 146, 60); h = @(3, 4, 3) },
  @{ x = 530; c = [System.Drawing.Color]::FromArgb(255, 250, 204, 21); h = @(4, 5, 3) },
  @{ x = 608; c = [System.Drawing.Color]::FromArgb(255, 232, 121, 249); h = @(3, 4, 4) },
  @{ x = 686; c = [System.Drawing.Color]::FromArgb(255, 167, 139, 250); h = @(4, 3, 3) },
  @{ x = 764; c = [System.Drawing.Color]::FromArgb(255, 56, 189, 248); h = @(3, 4, 4) }
)
foreach ($col in $cols) {
  $brush = New-Object System.Drawing.SolidBrush($col.c)
  $weak = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(120, $col.c.R, $col.c.G, $col.c.B))
  $yTop = $wy - 130
  foreach ($n in $col.h) {
    for ($i = 0; $i -lt $n; $i++) {
      $g.FillRectangle($brush, $col.x, $yTop, 40, 11)
      $yTop += 18
    }
    $yTop += 14
  }
  $yBot = $wy + 34
  foreach ($n in $col.h) {
    for ($i = 0; $i -lt [math]::Max(1, $n - 1); $i++) {
      $g.FillRectangle($weak, $col.x, $yBot, 40, 11)
      $yBot += 18
    }
    $yBot += 14
  }
}
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "icone vetorial salvo em $Out"