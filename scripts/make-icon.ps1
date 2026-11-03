# Generates desktop/TaskSync.Desktop/Assets/tasksync.ico (PNG-compressed ICO, 16-256 px) and the
# web app icons (web/public/icon-192.png, icon-512.png) from code, without design tools.
param(
  [string]$Out = "$PSScriptRoot\..\desktop\TaskSync.Desktop\Assets\tasksync.ico",
  [string]$WebDir = "$PSScriptRoot\..\web\public"
)
Add-Type -AssemblyName System.Drawing

function New-IconPng([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $pad = [Math]::Max(1, [int]($size * 0.06))
  $r = [int]($size * 0.26)
  $rect = New-Object System.Drawing.Rectangle $pad, $pad, ($size - 2 * $pad), ($size - 2 * $pad)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
  $path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
  $path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
  $path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.Color]::FromArgb(255, 91, 140, 255)), ([System.Drawing.Color]::FromArgb(255, 192, 132, 252)), 45
  $blend = New-Object System.Drawing.Drawing2D.ColorBlend 3
  $blend.Colors = @([System.Drawing.Color]::FromArgb(255, 91, 140, 255), [System.Drawing.Color]::FromArgb(255, 139, 92, 246), [System.Drawing.Color]::FromArgb(255, 192, 132, 252))
  $blend.Positions = @(0.0, 0.55, 1.0)
  $brush.InterpolationColors = $blend
  $g.FillPath($brush, $path)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), ([float]($size * 0.11))
  $pen.StartCap = 'Round'; $pen.EndCap = 'Round'; $pen.LineJoin = 'Round'
  $pts = @(
    (New-Object System.Drawing.PointF ($size * 0.30), ($size * 0.53)),
    (New-Object System.Drawing.PointF ($size * 0.44), ($size * 0.66)),
    (New-Object System.Drawing.PointF ($size * 0.71), ($size * 0.37))
  )
  $g.DrawLines($pen, $pts)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  return ,$ms.ToArray()
}

$sizes = 16, 24, 32, 48, 64, 128, 256
$images = foreach ($s in $sizes) { ,(New-IconPng $s) }
$fs = [System.IO.File]::Create((Resolve-Path -LiteralPath (Split-Path $Out) | ForEach-Object { Join-Path $_ (Split-Path $Out -Leaf) }))
$w = New-Object System.IO.BinaryWriter $fs
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $len = $images[$i].Length
  $w.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
  $w.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
  $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([UInt16]1); $w.Write([UInt16]32)
  $w.Write([UInt32]$len); $w.Write([UInt32]$offset)
  $offset += $len
}
foreach ($img in $images) { $w.Write($img) }
$w.Close()
Write-Output "Wrote $Out"

# PNG icons for the installable web app (Edge "Install this site as an app").
foreach ($s in 192, 512) {
  [System.IO.File]::WriteAllBytes((Join-Path (Resolve-Path $WebDir) "icon-$s.png"), (New-IconPng $s))
  Write-Output "Wrote icon-$s.png"
}
