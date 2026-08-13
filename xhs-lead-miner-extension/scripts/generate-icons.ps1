Add-Type -AssemblyName System.Drawing

function New-Icon {
  param(
    [int]$Size,
    [string]$Path
  )

  $bmp = New-Object System.Drawing.Bitmap $Size, $Size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::FromArgb(255, 36, 66))
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $fontSize = [Math]::Max(6, [int]($Size / 3))
  $font = New-Object System.Drawing.Font('Arial', $fontSize, [System.Drawing.FontStyle]::Bold)
  $format = New-Object System.Drawing.StringFormat
  $format.Alignment = 'Center'
  $format.LineAlignment = 'Center'
  $g.DrawString('X', $font, $brush, ($Size / 2), ($Size / 2), $format)
  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
}

$base = Join-Path $PSScriptRoot 'icons'
New-Icon -Size 16 -Path (Join-Path $base 'icon16.png')
New-Icon -Size 48 -Path (Join-Path $base 'icon48.png')
New-Icon -Size 128 -Path (Join-Path $base 'icon128.png')
Write-Output 'icons created'
