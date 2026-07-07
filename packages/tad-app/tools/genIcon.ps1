# Generates res/AppIcon1024.png: the Tads app icon.
# Design replicates the original Tad icon (blue gradient rounded square,
# white wordmark, table bars) with a Stata-style serif-italic 's' appended.
param(
    [string]$OutPath = "$PSScriptRoot\..\res\AppIcon1024.png",
    # If set, also write resized icon_<size>.png files here (input for makeIcns.js)
    [string]$SizesDir = ""
)
Add-Type -AssemblyName System.Drawing

$W = 1024; $H = 1024; $radius = 75

$bmp = New-Object System.Drawing.Bitmap($W, $H, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

# Rounded-rect background with the original diagonal gradient
# (light #1D8ADF at top-right, dark #0A6FC0 at bottom-left)
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$d = $radius * 2
$path.AddArc($W - $d, 0, $d, $d, 270, 90)
$path.AddArc($W - $d, $H - $d, $d, $d, 0, 90)
$path.AddArc(0, $H - $d, $d, $d, 90, 90)
$path.AddArc(0, 0, $d, $d, 180, 90)
$path.CloseFigure()

$light = [System.Drawing.Color]::FromArgb(255, 29, 138, 223)
$dark = [System.Drawing.Color]::FromArgb(255, 10, 111, 192)
$grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point($W, 0)),
    (New-Object System.Drawing.Point(0, $H)),
    $light, $dark)
$g.FillPath($grad, $path)

$white = [System.Drawing.Brushes]::White

# Wordmark: "Tad" in Arial Bold + Stata-style "s" in Georgia Bold Italic,
# sharing a baseline, sized to span the same margins as the original.
$baseline = 472.0
$targetLeft = 98.0
$targetRight = 926.0

function Get-TightBounds($g, [string]$text, $font) {
    $fmt = [System.Drawing.StringFormat]::GenericTypographic.Clone()
    $fmt.FormatFlags = $fmt.FormatFlags -bor [System.Drawing.StringFormatFlags]::NoClip
    $range = New-Object System.Drawing.CharacterRange(0, $text.Length)
    $fmt.SetMeasurableCharacterRanges(@($range))
    $rect = New-Object System.Drawing.RectangleF(0, 0, 4000, 2000)
    $regions = $g.MeasureCharacterRanges($text, $font, $rect, $fmt)
    return $regions[0].GetBounds($g)
}

# Initial guess for em sizes; then scale both uniformly to hit target width.
$sansSize = 452.0
$serifSize = $sansSize * 1.02   # georgia italic 's' sized to blend with arial x-height

for ($iter = 0; $iter -lt 3; $iter++) {
    $fTad = New-Object System.Drawing.Font("Arial", $sansSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $fS = New-Object System.Drawing.Font("Georgia", $serifSize, ([System.Drawing.FontStyle]::Bold -bor [System.Drawing.FontStyle]::Italic), [System.Drawing.GraphicsUnit]::Pixel)
    $bTad = Get-TightBounds $g "Tad" $fTad
    $bS = Get-TightBounds $g "s" $fS
    $gap = $sansSize * 0.02
    $total = $bTad.Width + $gap + $bS.Width
    $scale = ($targetRight - $targetLeft) / $total
    if ([Math]::Abs($scale - 1.0) -lt 0.005) { break }
    $sansSize *= $scale
    $serifSize *= $scale
}

# Baseline offsets: DrawString draws from the top of the em cell.
function Get-AscentPx($font) {
    $fam = $font.FontFamily
    $style = $font.Style
    return $font.Size * $fam.GetCellAscent($style) / $fam.GetEmHeight($style)
}

$fmtDraw = [System.Drawing.StringFormat]::GenericTypographic.Clone()

$bTad = Get-TightBounds $g "Tad" $fTad
$bS = Get-TightBounds $g "s" $fS
$gap = $sansSize * 0.02

$xTad = $targetLeft - $bTad.X
$g.DrawString("Tad", $fTad, $white, $xTad, ($baseline - (Get-AscentPx $fTad)), $fmtDraw)

$xS = $targetLeft + $bTad.Width + $gap - $bS.X
$g.DrawString("s", $fS, $white, $xS, ($baseline - (Get-AscentPx $fS)), $fmtDraw)

# Table bars (exact geometry from the original icon)
$bars = @(
    @(98, 551, 529), @(608, 551, 857),
    @(252, 641, 529), @(608, 641, 857),
    @(252, 731, 529), @(608, 731, 857),
    @(368, 821, 529), @(608, 821, 857)
)
foreach ($b in $bars) {
    $g.FillRectangle($white, [single]$b[0], [single]$b[1], [single]($b[2] - $b[0] + 1), 50.0)
}

$g.Dispose()
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "Wrote $OutPath (Tad=$([Math]::Round($sansSize,1))px, s=$([Math]::Round($serifSize,1))px)"

if ($SizesDir) {
    New-Item -ItemType Directory -Force $SizesDir | Out-Null
    foreach ($size in @(16, 32, 64, 128, 256, 512, 1024)) {
        $small = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $sg = [System.Drawing.Graphics]::FromImage($small)
        $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $sg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $sg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $sg.DrawImage($bmp, 0, 0, $size, $size)
        $sg.Dispose()
        $small.Save((Join-Path $SizesDir "icon_$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
        $small.Dispose()
    }
    Write-Output "Wrote resized icons to $SizesDir"
}
$bmp.Dispose()
