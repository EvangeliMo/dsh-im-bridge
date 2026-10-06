# Install dsh-im-bridge into the desktop profile.
#
# Follows the conventions established by the workspace's .deploy-plugins.ps1:
#   1. Copy REAL directories, never junctions -- the app's recovery flow
#      follows junctions and deletes their targets (it destroyed plugin
#      sources once before).
#   2. Write the profile package.json as UTF-8 WITHOUT a BOM -- dsh-host reads
#      it with a bare JSON.parse(), so a BOM crashes startup with
#      "Unexpected token '\uFEFF'".
#   3. Only packages listed in dsh.profile.bundles get composed into
#      cordis.yml; a dependency that is missing from bundles never loads.
#
# NOTE: keep every string in this file ASCII-only. Windows PowerShell 5.1
# decodes .ps1 files as ANSI, so non-ASCII string literals corrupt the parse.
#
# Usage: powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1
$ErrorActionPreference = 'Stop'

$src = Split-Path -Parent $PSScriptRoot          # plugin source directory
if (-not (Test-Path (Join-Path $src 'package.json'))) { throw "plugin source not found: $src" }

$name = 'dsh-im-bridge'
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome 'profiles\desktop'
if (-not (Test-Path $profileDir)) { throw "profile not found: $profileDir" }

# ---- 1. back up ------------------------------------------------------------
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bak = Join-Path $profileDir ("_backup_{0}_{1}" -f $name, $stamp)
New-Item -ItemType Directory -Path $bak -Force | Out-Null
foreach ($f in @('package.json', 'cordis.patch.yml', 'cordis.yml')) {
  $p = Join-Path $profileDir $f
  if (Test-Path $p) { Copy-Item $p $bak -Force }
}
Write-Host ("[1/3] backup -> {0}" -f $bak)

# ---- 2. real-directory copy ------------------------------------------------
$dst = Join-Path $profileDir ("node_modules\{0}" -f $name)
if (Test-Path $dst) {
  $item = Get-Item $dst -Force
  if ($item.LinkType) { cmd /c rmdir "`"$dst`"" | Out-Null } else { Remove-Item $dst -Recurse -Force }
}
robocopy $src $dst /E /XJ /XD node_modules .git /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw ("robocopy failed (exit {0})" -f $LASTEXITCODE) }
$fileCount = (Get-ChildItem $dst -Recurse -File).Count
Write-Host ("[2/3] deployed -> {0} ({1} files)" -f $dst, $fileCount)

# ---- 3. profile manifest (BOM-less, idempotent) ----------------------------
$manifestPath = Join-Path $profileDir 'package.json'
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json

$linkTarget = $src -replace '\\', '/'
$manifest.dependencies | Add-Member -NotePropertyName $name -NotePropertyValue ("link:{0}" -f $linkTarget) -Force

$bundles = @($manifest.dsh.profile.bundles)
if ($bundles -notcontains $name) { $bundles += $name }
$manifest.dsh.profile.bundles = $bundles

$json = $manifest | ConvertTo-Json -Depth 12
[System.IO.File]::WriteAllText($manifestPath, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))

$head = [System.IO.File]::ReadAllBytes($manifestPath)[0..2]
if ($head[0] -eq 0xEF -and $head[1] -eq 0xBB -and $head[2] -eq 0xBF) {
  throw "package.json was written with a UTF-8 BOM - this crashes dsh on startup. Aborted."
}
Write-Host ("[3/3] manifest updated (bundles: {0}, no BOM)" -f $bundles.Count)

Write-Host ''
Write-Host "Installed. Restart DeepSeek Harness, then send '/im status' in any session." -ForegroundColor Green

# ---- 4. drop the binding guide where an agent will find it -----------------
# Users are expected to ask their own agent "how do I bind WeChat / QQ?".
# Putting the guide at the root of DSH_HOME makes that answer discoverable
# without anyone having to know the plugin lives under node_modules.
$guideSrc = Join-Path $src 'BINDING.md'
$guideDst = Join-Path $dshHome 'IM_BRIDGE_BINDING.md'
if (Test-Path $guideSrc) {
  Copy-Item $guideSrc $guideDst -Force
  Write-Host ''
  Write-Host "Binding guide: $guideDst" -ForegroundColor Cyan
  Write-Host "Ask your agent to read it (or run '/im guide') to bind WeChat / QQ." -ForegroundColor Cyan
}
