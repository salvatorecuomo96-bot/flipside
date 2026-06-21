Add-Type -AssemblyName System.IO.Compression.FileSystem
$src = $PSScriptRoot
$dist = Join-Path $src "dist"
if (-not (Test-Path $dist)) { New-Item -ItemType Directory -Path $dist | Out-Null }

# Archive older zips — move any existing zip that doesn't match current version
# into dist/archive/ so dist/ always shows only the newest build.
$archive = Join-Path $dist "archive"
if (-not (Test-Path $archive)) { New-Item -ItemType Directory -Path $archive | Out-Null }

# -Encoding UTF8 is required: Windows PowerShell 5.1 otherwise reads UTF-8 files
# as ANSI, corrupting non-ASCII chars like the em-dash in default_title.
$manifestContent = Get-Content (Join-Path $src "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $manifestContent.version

Get-ChildItem -Path $dist -Filter "*.zip" | Where-Object {
  $_.Name -notmatch "v$([regex]::Escape($version))-"
} | ForEach-Object {
  Move-Item -Path $_.FullName -Destination (Join-Path $archive $_.Name) -Force
  Write-Host "Archived: $($_.Name)"
}

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
  # UTF-8 without BOM — a BOM can break manifest parsers.
  $writer = [System.IO.StreamWriter]::new($manifestStream, [System.Text.UTF8Encoding]::new($false))
  # ConvertTo-Json stringifies it.
  $json = $manifestObject | ConvertTo-Json -Depth 10
  # Windows PowerShell 5.1 collapses single-element arrays to scalars in JSON,
  # which would make Firefox's "scripts" and "data_collection_permissions.required"
  # invalid (must be arrays). Re-array them if they came out as bare strings.
  $json = $json -replace '("scripts":\s*)"([^"]+)"', '$1["$2"]'
  $json = $json -replace '("required":\s*)"([^"]+)"', '$1["$2"]'
  $writer.Write($json)
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
$manifestFirefox = Get-Content (Join-Path $src "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$manifestFirefox.background = @{
  scripts = @($manifestFirefox.background.service_worker)
  type = "module"
}
$manifestFirefox | Add-Member -MemberType NoteProperty -Name "browser_specific_settings" -Value @{
  gecko = @{
    id = "FlipSide@ducksamurai.example.com"
    strict_min_version = "109.0"
    # AMO requires a data-collection declaration. FlipSide transmits the article
    # text (page content) to the proxy/providers to generate a result; it stores
    # no personal data. This matches store/PRIVACY.md.
    data_collection_permissions = @{
      required = @("websiteContent")
    }
  }
}
Build-Zip -outPath $outFirefox -manifestObject $manifestFirefox
