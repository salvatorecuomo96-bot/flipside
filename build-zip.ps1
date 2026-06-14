Add-Type -AssemblyName System.IO.Compression.FileSystem
$src = $PSScriptRoot
$dist = Join-Path $src "dist"
if (-not (Test-Path $dist)) { New-Item -ItemType Directory -Path $dist | Out-Null }

$manifestContent = Get-Content (Join-Path $src "manifest.json") -Raw | ConvertFrom-Json
$version = $manifestContent.version

$outChrome = Join-Path $dist "FlipSide-v$version-chrome.zip"
$outFirefox = Join-Path $dist "FlipSide-v$version-firefox.zip"

if (Test-Path $outChrome) { Remove-Item $outChrome }
if (Test-Path $outFirefox) { Remove-Item $outFirefox }

$files = (
  Get-ChildItem -Recurse (Join-Path $src "src"), (Join-Path $src "icons") |
  Where-Object { -not $_.PSIsContainer } |
  ForEach-Object { $_.FullName.Substring($src.Length + 1) }
)

function Build-Zip($outPath, $manifestObject) {
  $archive = [System.IO.Compression.ZipFile]::Open($outPath, 'Create')
  
  # Add manifest.json
  $manifestEntry = $archive.CreateEntry("manifest.json")
  $manifestStream = $manifestEntry.Open()
  $writer = [System.IO.StreamWriter]::new($manifestStream)
  # ConvertTo-Json stringifies it.
  $writer.Write(($manifestObject | ConvertTo-Json -Depth 10))
  $writer.Close()
  
  # Add other files
  foreach ($rel in $files) {
    $entryName = $rel.Replace([char]92, [char]47)
    $entry = $archive.CreateEntry($entryName)
    $entryStream = $entry.Open()
    $bytes = [System.IO.File]::ReadAllBytes((Join-Path $src $rel))
    $entryStream.Write($bytes, 0, $bytes.Length)
    $entryStream.Close()
  }
  
  $archive.Dispose()
  Write-Host "Built: $outPath ($((Get-Item $outPath).Length) bytes)"
}

# Chrome Build
Build-Zip -outPath $outChrome -manifestObject $manifestContent

# Firefox Build
# In PowerShell, a deep copy of a PSCustomObject is needed, but we can just re-parse.
$manifestFirefox = Get-Content (Join-Path $src "manifest.json") -Raw | ConvertFrom-Json
$manifestFirefox.background = @{
  scripts = @($manifestFirefox.background.service_worker)
  type = "module"
}
$manifestFirefox | Add-Member -MemberType NoteProperty -Name "browser_specific_settings" -Value @{
  gecko = @{
    id = "FlipSide@ducksamurai.example.com"
    strict_min_version = "109.0"
  }
}
Build-Zip -outPath $outFirefox -manifestObject $manifestFirefox
