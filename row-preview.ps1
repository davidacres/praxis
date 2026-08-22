Add-Type -AssemblyName System.Drawing
$bmp = [System.Drawing.Image]::FromFile('C:\dev-ai\tools\ticket-manager\titlebar-200.png')
$rows = @(0, 5, 10, 15, 20, 25, 30, 35, 40)
foreach ($y in $rows) {
  $line = ''
  for ($x = 0; $x -lt 200; $x += 4) {
    $c = $bmp.GetPixel($x, $y)
    if ($c.R -lt 60 -and $c.G -lt 60 -and $c.B -lt 60) { $line += '#' }
    elseif ($c.R -gt 200 -and $c.G -gt 200 -and $c.B -gt 200) { $line += '.' }
    elseif ($c.G -gt 150 -and $c.R -lt 100) { $line += 'G' }
    elseif ($c.R -gt 100 -and $c.G -gt 100 -and $c.B -gt 100) { $line += '+' }
    elseif ($c.R -gt 60 -and $c.G -gt 60 -and $c.B -gt 60) { $line += 'o' }
    else { $line += '?' }
  }
  Write-Host ("y={0,2}: {1}" -f $y, $line)
}
