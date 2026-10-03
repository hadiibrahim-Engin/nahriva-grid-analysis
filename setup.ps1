<#
.SYNOPSIS
  One script from A to Z: sets up Python, the backend, Node, the frontend and the configuration.
  Needs no administrator rights and changes nothing outside this folder.

.DESCRIPTION
  1. Python 3.12+: uses the one on this PC; otherwise downloads the portable "uv" into .tools\ and lets
     it install Python for the current user.
  2. Backend: creates backend\.venv and installs the packages.
  3. Frontend: builds frontend\dist. A release package already contains it, then this step is skipped.
     Otherwise Node 22.13+ is used; if it is missing, portable Node is downloaded into .tools\.
  4. Writes outage-assessment.config.json (127.0.0.1, one port).
  5. Optional (-Autostart): per-user logon task that keeps the dashboard running.
  6. Self-test: starts the server, checks it and stops it again.

  Run it again at any time: finished steps are skipped (-Force rewrites the configuration).

  In PowerFactory you then add exactly ONE script: powerfactory\start_assessment.py

.PARAMETER Database    Results database (default: backend\data\outage-assessment.sqlite3)
.PARAMETER Port        Dashboard port (default 8765)
.PARAMETER Python      Path of a specific python.exe (3.12+)
.PARAMETER Wheelhouse  Folder with pre-downloaded packages for PCs without internet access
.PARAMETER Autostart   Also start the dashboard at every logon of this user (no elevation)
.PARAMETER Package     Also build the release ZIP for other PCs (release\outage-assessment-<version>.zip)
.PARAMETER RebuildFrontend  Build the frontend even if frontend\dist exists
.PARAMETER Force       Overwrite an existing configuration file

.EXAMPLE
  .\setup.ps1
.EXAMPLE
  .\setup.ps1 -Autostart -Database D:\OutageAssessment\outages.sqlite3
#>
[CmdletBinding()]
param(
  [string]$Database,
  [int]$Port = 8765,
  [string]$Python,
  [string]$Wheelhouse,
  [switch]$Autostart,
  [switch]$Package,
  [switch]$RebuildFrontend,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

$Root = $PSScriptRoot
$Tools = Join-Path $Root '.tools'
$IsWin = ($env:OS -eq 'Windows_NT')
$TaskName = 'OutageAssessmentDashboard'
$MinNode = [version]'22.13.0'
$FallbackNode = '22.16.0'
$Venv = Join-Path $Root 'backend\.venv'
$VenvPython = if ($IsWin) { Join-Path $Venv 'Scripts\python.exe' } else { Join-Path $Venv 'bin/python' }
$script:Uv = $null

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Info($text) { Write-Host "   $text" }
function Fail($text) { throw $text }

function Download($url, $target) {
  Info "Downloading $url"
  try { Invoke-WebRequest -Uri $url -OutFile $target -UseBasicParsing }
  catch { Fail "Download failed: $url ($($_.Exception.Message)). Check the internet connection or the proxy settings." }
}

function Verify-Hash($file, $expected) {
  $actual = (Get-FileHash -Algorithm SHA256 -Path $file).Hash.ToLowerInvariant()
  if ($actual -ne $expected.ToLowerInvariant()) { Fail "Checksum mismatch for $file. The download is not trusted and was not used." }
}

function Windows-Arch { if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' } }

# ---- 1. Python -----------------------------------------------------------------------------------

function Test-Python($exe, $prefix) {
  try {
    $v = & $exe @prefix -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
    if ($LASTEXITCODE -eq 0 -and [version]$v -ge [version]'3.12') { return @($exe) + $prefix }
  } catch { }
  return $null
}

function Find-Python {
  $found = @()
  if ($Python) { $found = @(Test-Python $Python @()) }
  if (-not $found) { $found = @(Test-Python 'py' @('-3.12')) }
  if (-not $found) { $found = @(Test-Python 'python' @()) }
  if (-not $found) { $found = @(Test-Python 'python3' @()) }
  return $found
}

function Get-Uv {
  if ($script:Uv) { return $script:Uv }
  $existing = Get-Command uv -ErrorAction SilentlyContinue
  if ($existing) { $script:Uv = $existing.Source; return $script:Uv }
  if (-not $IsWin) { Fail 'Python 3.12 or newer is required (install it, or install uv from https://docs.astral.sh/uv/).' }
  $dir = Join-Path $Tools 'uv'
  $exe = Join-Path $dir 'uv.exe'
  if (-not (Test-Path $exe)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $arch = if ((Windows-Arch) -eq 'arm64') { 'aarch64' } else { 'x86_64' }
    $name = "uv-$arch-pc-windows-msvc.zip"
    $zip = Join-Path $Tools $name
    $base = 'https://github.com/astral-sh/uv/releases/latest/download'
    Download "$base/$name" $zip
    Download "$base/$name.sha256" "$zip.sha256"
    $expected = ((Get-Content "$zip.sha256" -Raw).Trim() -split '\s+')[0]
    Verify-Hash $zip $expected
    Expand-Archive -Path $zip -DestinationPath $dir -Force
    $inner = Get-ChildItem -Path $dir -Recurse -Filter uv.exe | Select-Object -First 1
    if (-not $inner) { Fail 'uv.exe was not found in the downloaded archive.' }
    if ($inner.FullName -ne $exe) { Copy-Item $inner.FullName $exe -Force }
    Remove-Item $zip, "$zip.sha256" -Force -ErrorAction SilentlyContinue
  }
  $script:Uv = $exe
  return $exe
}

Step '1/6 Python 3.12+'
$py = @(Find-Python)
if ($py) { Info "Using $($py -join ' ')" } else {
  Info 'Python 3.12+ was not found on this PC; the portable uv installs it for the current user.'
  [void](Get-Uv)
}

# ---- 2. Backend ----------------------------------------------------------------------------------

Step '2/6 Backend environment'
if (-not (Test-Path $VenvPython)) {
  if ($py) {
    $pyArgs = @()
    if ($py.Length -gt 1) { $pyArgs = $py[1..($py.Length - 1)] }
    & $py[0] @pyArgs -m venv $Venv
    if ($LASTEXITCODE) { Fail 'The virtual environment could not be created.' }
  } else {
    & (Get-Uv) venv --python 3.12 $Venv
    if ($LASTEXITCODE) { Fail 'uv could not create the Python 3.12 environment.' }
  }
}
$BackendDir = Join-Path $Root 'backend'
$hasPip = $false
try { & $VenvPython -m pip --version 2>&1 | Out-Null; $hasPip = ($LASTEXITCODE -eq 0) } catch { }
if (-not $hasPip -and -not $script:Uv -and -not (Get-Command uv -ErrorAction SilentlyContinue)) {
  & $VenvPython -m ensurepip --upgrade 2>&1 | Out-Null
  try { & $VenvPython -m pip --version 2>&1 | Out-Null; $hasPip = ($LASTEXITCODE -eq 0) } catch { }
}
if ($hasPip) {
  $pipArgs = @('-m', 'pip', 'install', '--disable-pip-version-check', '--quiet')
  if ($Wheelhouse) { $pipArgs += @('--no-index', '--find-links', $Wheelhouse) }
  & $VenvPython @pipArgs $BackendDir
} else {
  $uvArgs = @('pip', 'install', '--python', $VenvPython, '--quiet')
  if ($Wheelhouse) { $uvArgs += @('--no-index', '--find-links', $Wheelhouse) }
  & (Get-Uv) @uvArgs $BackendDir
}
if ($LASTEXITCODE) { Fail 'Package installation failed (no internet access? Use -Wheelhouse, see docs/DEPLOYMENT.md).' }
Info 'Backend packages are installed.'

# ---- 3. Frontend ---------------------------------------------------------------------------------

function Find-Node {
  $nodeExe = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeExe) {
    $v = (& $nodeExe.Source -p 'process.versions.node').Trim()
    if ([version]$v -ge $MinNode) { return Split-Path $nodeExe.Source }
  }
  $local = Get-ChildItem -Path (Join-Path $Tools 'node') -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($local -and (Test-Path (Join-Path $local.FullName 'node.exe'))) { return $local.FullName }
  return $null
}

function Install-PortableNode {
  if (-not $IsWin) { Fail "Node.js $MinNode or newer is required to build the frontend (https://nodejs.org)." }
  $arch = Windows-Arch
  $name = "node-v$FallbackNode-win-$arch.zip"
  $base = "https://nodejs.org/dist/v$FallbackNode"
  New-Item -ItemType Directory -Force -Path (Join-Path $Tools 'node') | Out-Null
  $zip = Join-Path $Tools $name
  Download "$base/$name" $zip
  Download "$base/SHASUMS256.txt" "$zip.sums"
  $line = (Get-Content "$zip.sums") | Where-Object { $_ -match [regex]::Escape($name) + '$' } | Select-Object -First 1
  if (-not $line) { Fail "No checksum for $name was published." }
  Verify-Hash $zip (($line -split '\s+')[0])
  Expand-Archive -Path $zip -DestinationPath (Join-Path $Tools 'node') -Force
  Remove-Item $zip, "$zip.sums" -Force -ErrorAction SilentlyContinue
  return (Join-Path (Join-Path $Tools 'node') "node-v$FallbackNode-win-$arch")
}

Step '3/6 Frontend'
$Dist = Join-Path $Root 'frontend\dist\index.html'
$HasSources = Test-Path (Join-Path $Root 'frontend\package.json')
if ((Test-Path $Dist) -and -not $RebuildFrontend -and -not $Package) {
  Info 'frontend\dist exists, nothing to build.'
} elseif (-not $HasSources) {
  if (-not (Test-Path $Dist)) { Fail 'frontend\dist is missing and there are no frontend sources. Use the complete release package.' }
  Info 'Release package: the frontend is already built.'
} else {
  $nodeDir = Find-Node
  if (-not $nodeDir) { Info "Node $MinNode+ was not found; downloading portable Node."; $nodeDir = Install-PortableNode }
  $env:PATH = $nodeDir + [IO.Path]::PathSeparator + $env:PATH
  $npm = if ($IsWin) { Join-Path $nodeDir 'npm.cmd' } else { 'npm' }
  Info "Using Node $((& (Join-Path $nodeDir $(if ($IsWin) { 'node.exe' } else { 'node' })) -p 'process.versions.node').Trim())"
  Push-Location (Join-Path $Root 'frontend')
  try {
    $lockHash = (Get-FileHash -Algorithm SHA256 -Path 'package-lock.json').Hash
    $marker = Join-Path 'node_modules' '.setup-lock-hash'
    $installed = if (Test-Path $marker) { (Get-Content $marker -Raw).Trim() } else { '' }
    if ($installed -ne $lockHash -or -not (Test-Path 'node_modules')) {
      Info 'Installing frontend packages (npm ci)'
      & $npm ci --no-audit --no-fund
      if ($LASTEXITCODE) { Fail 'npm ci failed.' }
      Set-Content -Path $marker -Value $lockHash -Encoding ASCII
    }
    Info 'Building the frontend (npm run build)'
    & $npm run build
    if ($LASTEXITCODE) { Fail 'The frontend build failed.' }
  } finally { Pop-Location }
}
if (-not (Test-Path $Dist)) { Fail 'frontend\dist\index.html is missing after the build.' }

# ---- 4. Configuration ----------------------------------------------------------------------------

Step '4/6 Configuration'
$ConfigPath = Join-Path $Root 'outage-assessment.config.json'
if ((Test-Path $ConfigPath) -and -not $Force) {
  Info "Exists, left unchanged: $ConfigPath (use -Force to rewrite)"
} else {
  if (-not $Database) { $Database = Join-Path $Root 'backend\data\outage-assessment.sqlite3' }
  $cfg = [ordered]@{ database = $Database; host = '127.0.0.1'; port = $Port }
  $cfg | ConvertTo-Json | Set-Content -Path $ConfigPath -Encoding UTF8
  Info "Written: $ConfigPath"
}
$cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
$Port = [int]$cfg.port
New-Item -ItemType Directory -Force -Path (Split-Path $cfg.database) | Out-Null

# ---- 5. Autostart (optional) ---------------------------------------------------------------------

Step '5/6 Autostart (optional)'
$Serve = Join-Path $Root 'scripts\serve.py'
if (-not $Autostart) {
  Info 'Skipped. Add -Autostart to start the dashboard at every logon. Without it the PowerFactory script shows it.'
} elseif (-not $IsWin) {
  Info 'Autostart is only available on Windows.'
} else {
  $Pythonw = Join-Path $Venv 'Scripts\pythonw.exe'
  if (-not (Test-Path $Pythonw)) { $Pythonw = $VenvPython }
  $user = "$env:USERDOMAIN\$env:USERNAME"
  $action = New-ScheduledTaskAction -Execute $Pythonw -Argument "`"$Serve`"" -WorkingDirectory $Root
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  $settings = New-ScheduledTaskSettingsSet -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  try {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Info "Task '$TaskName' created and started (runs at every logon of this user)."
  } catch {
    Write-Warning "Autostart could not be set up: $($_.Exception.Message). The dashboard still works."
  }
}

# ---- 6. Self-test --------------------------------------------------------------------------------

Step '6/6 Self-test'
$serving = $false
try { $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health/ready" -TimeoutSec 2; $serving = ($r.status -eq 'ready') } catch { }
if ($serving) {
  Info "A dashboard already answers on port $Port."
} else {
  $log = Join-Path $Tools 'selftest.log'
  New-Item -ItemType Directory -Force -Path $Tools | Out-Null
  $startArgs = @{ FilePath = $VenvPython; ArgumentList = @("`"$Serve`""); WorkingDirectory = $Root; PassThru = $true
                  RedirectStandardOutput = $log; RedirectStandardError = "$log.err" }
  if ($IsWin) { $startArgs.WindowStyle = 'Hidden' }
  $proc = Start-Process @startArgs
  $ok = $false
  for ($i = 0; $i -lt 60 -and -not $ok -and -not $proc.HasExited; $i++) {
    try { $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health/ready" -TimeoutSec 2; $ok = ($r.status -eq 'ready') } catch { Start-Sleep -Milliseconds 500 }
  }
  if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  if (-not $ok) { Fail "The dashboard server did not start. See $log.err" }
  Info 'The dashboard server starts and answers.'
}

if ($Package) {
  Step 'Release package'
  & $VenvPython (Join-Path $Root 'scripts\package_release.py')
  if ($LASTEXITCODE) { Fail 'The release package could not be built.' }
}

$StartScript = Join-Path $Root 'powerfactory\start_assessment.py'
Write-Host "`nReady." -ForegroundColor Green
Write-Host '  In PowerFactory add ONE script:'
Write-Host '    Data Manager > new object "ComPython" (external script file) > script file:'
Write-Host "    $StartScript" -ForegroundColor Yellow
Write-Host '  Activate the project and study case, then Execute. When the calculation is finished the script'
Write-Host "  starts the dashboard and opens it in your browser (http://127.0.0.1:$Port)."
