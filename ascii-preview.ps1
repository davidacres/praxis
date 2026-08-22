Add-Type -AssemblyName System.Drawing
$bmp = [System.Drawing.Image]::FromFile('C:\dev-ai\tools\ticket-manager\titlebar-200.png')
for ($y = 0; $y -lt 80; $y += 4) {
  $line = ''
  for ($x = 0; $x -lt 200; $x += 6) {
    $c = $bmp.GetPixel($x, $y)
    if ($c.R -lt 50 -and $c.G -lt 50 -and $c.B -lt 50) { $line += '#' }
    elseif ($c.G -gt 150 -and $c.R -lt 100) { $line += 'G' }
    elseif ($c.R -gt 200 -and $c.G -gt 200 -and $c.B -gt 200) { $line += '.' }
    else { $line += '?' }
  }
  Write-Host ("y={0,2}: {1}" -f $y, $line)
}
