Add-Type -AssemblyName System.IO.Compression.FileSystem
$src = $PSScriptRoot
$out = Join-Path $src "dist\flipside-v0.2.0.zip"
if (Test-Path $out) { Remove-Item $out }

$archive = [System.IO.Compression.ZipFile]::Open($out, 'Create')

$files = @("manifest.json") + (
  Get-ChildItem -Recurse (Join-Path $src "src"), (Join-Path $src "icons") |
  Where-Object { -not $_.PSIsContainer } |
  ForEach-Object { $_.FullName.Substring($src.Length + 1) }
)

foreach ($rel in $files) {
  $entryName = $rel.Replace([char]92, [char]47)
  $entry = $archive.CreateEntry($entryName)
  $entryStream = $entry.Open()
  $bytes = [System.IO.File]::ReadAllBytes((Join-Path $src $rel))
  $entryStream.Write($bytes, 0, $bytes.Length)
  $entryStream.Close()
}

$archive.Dispose()
Write-Host "Built: $out ($((Get-Item $out).Length) bytes, $($files.Count) files)"
