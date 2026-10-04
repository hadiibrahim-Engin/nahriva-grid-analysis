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

  Every step is reported in detail: what was found, what was decided and why, each command that is run
  (with its output, exit code and duration) and a summary of all steps at the end. The complete output
  is also written to .tools\setup.log.

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

$Clock = [Diagnostics.Stopwatch]::StartNew()
$script:Steps = New-Object System.Collections.ArrayList
$script:CurrentStep = $null
$script:StepClock = $null
$script:Transcript = $false

function Stamp { '{0:HH:mm:ss}' -f (Get-Date) }
function Close-Step([string]$status = 'ok') {
  if ($script:CurrentStep) {
    [void]$script:Steps.Add([pscustomobject]@{ Step = $script:CurrentStep; Seconds = $script:StepClock.Elapsed.TotalSeconds; Status = $status })
    $script:CurrentStep = $null
  }
}
function Step($text) {
  Close-Step
  $script:CurrentStep = $text
  $script:StepClock = [Diagnostics.Stopwatch]::StartNew()
  Write-Host "`n[$(Stamp)] == $text" -ForegroundColor Cyan
}
function Info($text) { Write-Host "   [$(Stamp)] $text" }
function Fail($text) { throw $text }

# Runs a program, shows the command line, its complete output, the exit code and the duration.
# Returns the exit code (the output goes to the console only, never into the return value).
function Invoke-Logged([string]$Exe, [string[]]$Arguments = @()) {
  Info "> $Exe $($Arguments -join ' ')"
  $watch = [Diagnostics.Stopwatch]::StartNew()
  # Windows PowerShell 5.1 turns every stderr line of a program into a terminating error under 'Stop'
  # (pip and npm print warnings there), so the output is read with 'Continue' and shown as plain text.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Exe @Arguments 2>&1 | ForEach-Object { "$_" } | Out-Host
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previous }
  Info ('  exit code {0} after {1:N1} s' -f $code, $watch.Elapsed.TotalSeconds)
  return $code
}

function Show-Summary {
  Close-Step
  Write-Host "`nSummary" -ForegroundColor Cyan
  foreach ($row in $script:Steps) { Write-Host ('   {0,-34} {1,7:N1} s  {2}' -f $row.Step, $row.Seconds, $row.Status) }
  Write-Host ('   {0,-34} {1,7:N1} s' -f 'Total', $Clock.Elapsed.TotalSeconds)
}

trap {
  $where = if ($script:CurrentStep) { "step '$script:CurrentStep'" } else { 'start-up' }
  Write-Host "`n[$(Stamp)] !! Setup failed in $where" -ForegroundColor Red
  Write-Host "   $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "   Call stack:"
  foreach ($line in ($_.ScriptStackTrace -split "`n")) { Write-Host "     $($line.Trim())" }
  Close-Step 'FAILED'
  Show-Summary
  if ($script:Transcript) { Write-Host "   Full log: $(Join-Path $Tools 'setup.log')"; try { Stop-Transcript | Out-Null } catch { } }
  break
}

try {
  New-Item -ItemType Directory -Force -Path $Tools | Out-Null
  Start-Transcript -Path (Join-Path $Tools 'setup.log') -Force | Out-Null
  $script:Transcript = $true
} catch { Write-Host "   (No log file: $($_.Exception.Message))" }

function Download($url, $target) {
  Info "Downloading $url"
  Info "  to $target"
  try { Invoke-WebRequest -Uri $url -OutFile $target -UseBasicParsing }
  catch { Fail "Download failed: $url ($($_.Exception.Message)). Check the internet connection or the proxy settings." }
}

function Verify-Hash($file, $expected) {
  $actual = (Get-FileHash -Algorithm SHA256 -Path $file).Hash.ToLowerInvariant()
  Info "  SHA-256 expected $($expected.ToLowerInvariant())"
  Info "  SHA-256 actual   $actual"
  if ($actual -ne $expected.ToLowerInvariant()) { Fail "Checksum mismatch for $file. The download is not trusted and was not used." }
  Info '  Checksum matches.'
}

function Windows-Arch { if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' } }

# ---- 1. Python -----------------------------------------------------------------------------------

function Test-Python($exe, $prefix) {
  $label = (@($exe) + $prefix) -join ' '
  try {
    $v = & $exe @prefix -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
    if ($LASTEXITCODE -ne 0) { Info "  candidate '$label': does not run (exit code $LASTEXITCODE)"; return $null }
    if ([version]$v -lt [version]'3.12') { Info "  candidate '$label': Python $v is too old (3.12+ needed)"; return $null }
    $where = (& $exe @prefix -c 'import sys; print(sys.executable)' 2>$null)
    Info "  candidate '$label': Python $v at $where - usable"
    return @($exe) + $prefix
  } catch { Info "  candidate '$label': not found" }
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
  if ($existing) { Info "uv found on this PC: $($existing.Source)"; $script:Uv = $existing.Source; return $script:Uv }
  if (-not $IsWin) { Fail 'Python 3.12 or newer is required (install it, or install uv from https://docs.astral.sh/uv/).' }
  $dir = Join-Path $Tools 'uv'
  $exe = Join-Path $dir 'uv.exe'
  if (Test-Path $exe) { Info "Portable uv already present: $exe" }
  else {
    Info 'uv is not installed; downloading the portable version into .tools\uv (current user, no administrator rights).'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $arch = if ((Windows-Arch) -eq 'arm64') { 'aarch64' } else { 'x86_64' }
    $name = "uv-$arch-pc-windows-msvc.zip"
    $zip = Join-Path $Tools $name
    $base = 'https://github.com/astral-sh/uv/releases/latest/download'
    Download "$base/$name" $zip
    Download "$base/$name.sha256" "$zip.sha256"
    $expected = ((Get-Content "$zip.sha256" -Raw).Trim() -split '\s+')[0]
    Verify-Hash $zip $expected
    Info "Extracting $zip"
    Expand-Archive -Path $zip -DestinationPath $dir -Force
    $inner = Get-ChildItem -Path $dir -Recurse -Filter uv.exe | Select-Object -First 1
    if (-not $inner) { Fail 'uv.exe was not found in the downloaded archive.' }
    if ($inner.FullName -ne $exe) { Copy-Item $inner.FullName $exe -Force }
    Remove-Item $zip, "$zip.sha256" -Force -ErrorAction SilentlyContinue
    Info "Installed: $exe"
  }
  $script:Uv = $exe
  [void](Invoke-Logged $exe @('--version'))
  return $exe
}

Step '1/6 Python 3.12+'
Info "Looking for Python 3.12+ (project folder: $Root)"
if ($Python) { Info "  -Python was given: $Python" }
$py = @(Find-Python)
if ($py) { Info "Decision: use $($py -join ' ')" } else {
  Info 'Python 3.12+ was not found on this PC; the portable uv installs it for the current user.'
  [void](Get-Uv)
}

# ---- 2. Backend ----------------------------------------------------------------------------------

Step '2/6 Backend environment'
if (Test-Path $VenvPython) {
  Info "Virtual environment exists: $Venv (not recreated)"
} else {
  Info "Creating the virtual environment: $Venv"
  if ($py) {
    $pyArgs = @()
    if ($py.Length -gt 1) { $pyArgs = $py[1..($py.Length - 1)] }
    if (Invoke-Logged $py[0] ($pyArgs + @('-m', 'venv', $Venv))) { Fail 'The virtual environment could not be created.' }
  } else {
    if (Invoke-Logged (Get-Uv) @('venv', '--python', '3.12', $Venv)) { Fail 'uv could not create the Python 3.12 environment.' }
  }
}
Info "Environment Python: $VenvPython"
[void](Invoke-Logged $VenvPython @('--version'))
$BackendDir = Join-Path $Root 'backend'
$hasPip = $false
try { & $VenvPython -m pip --version 2>&1 | Out-Null; $hasPip = ($LASTEXITCODE -eq 0) } catch { }
if (-not $hasPip -and -not $script:Uv -and -not (Get-Command uv -ErrorAction SilentlyContinue)) {
  & $VenvPython -m ensurepip --upgrade 2>&1 | Out-Null
  try { & $VenvPython -m pip --version 2>&1 | Out-Null; $hasPip = ($LASTEXITCODE -eq 0) } catch { }
}
if ($Wheelhouse) { Info "Offline installation from the wheelhouse: $Wheelhouse (no package index is contacted)" }
else { Info 'Packages are downloaded from the package index (internet access needed).' }
if ($hasPip) {
  Info 'Installer: pip'
  $pipArgs = @('-m', 'pip', 'install', '--disable-pip-version-check')
  if ($Wheelhouse) { $pipArgs += @('--no-index', '--find-links', $Wheelhouse) }
  $code = Invoke-Logged $VenvPython ($pipArgs + @($BackendDir))
} else {
  Info 'Installer: uv (the environment has no pip)'
  $uvArgs = @('pip', 'install', '--python', $VenvPython)
  if ($Wheelhouse) { $uvArgs += @('--no-index', '--find-links', $Wheelhouse) }
  $code = Invoke-Logged (Get-Uv) ($uvArgs + @($BackendDir))
}
if ($code) { Fail 'Package installation failed (no internet access? Use -Wheelhouse, see docs/DEPLOYMENT.md).' }
Info 'Installed packages in the backend environment:'
if ($hasPip) { [void](Invoke-Logged $VenvPython @('-m', 'pip', 'list', '--disable-pip-version-check')) }
else { [void](Invoke-Logged (Get-Uv) @('pip', 'list', '--python', $VenvPython)) }
Info 'Backend packages are installed.'

# ---- 3. Frontend ---------------------------------------------------------------------------------

function Find-Node {
  $nodeExe = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeExe) {
    $v = (& $nodeExe.Source -p 'process.versions.node').Trim()
    if ([version]$v -ge $MinNode) { Info "  Node $v on this PC at $($nodeExe.Source) - usable"; return Split-Path $nodeExe.Source }
    Info "  Node $v at $($nodeExe.Source) is too old ($MinNode+ needed)"
  } else { Info '  No Node on this PC' }
  $local = Get-ChildItem -Path (Join-Path $Tools 'node') -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($local -and (Test-Path (Join-Path $local.FullName 'node.exe'))) { Info "  Portable Node found: $($local.FullName)"; return $local.FullName }
  Info '  No portable Node in .tools\node'
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
  Info "Extracting $zip"
  Expand-Archive -Path $zip -DestinationPath (Join-Path $Tools 'node') -Force
  Remove-Item $zip, "$zip.sums" -Force -ErrorAction SilentlyContinue
  Info "Installed portable Node in $(Join-Path $Tools 'node')"
  return (Join-Path (Join-Path $Tools 'node') "node-v$FallbackNode-win-$arch")
}

Step '3/6 Frontend'
$Dist = Join-Path $Root 'frontend\dist\index.html'
$HasSources = Test-Path (Join-Path $Root 'frontend\package.json')
Info "frontend\dist\index.html present: $(Test-Path $Dist); frontend sources present: $HasSources; -RebuildFrontend: $($RebuildFrontend.IsPresent); -Package: $($Package.IsPresent)"
if ((Test-Path $Dist) -and -not $RebuildFrontend -and -not $Package) {
  Info 'Decision: frontend\dist exists, nothing to build (use -RebuildFrontend to force it).'
} elseif (-not $HasSources) {
  if (-not (Test-Path $Dist)) { Fail 'frontend\dist is missing and there are no frontend sources. Use the complete release package.' }
  Info 'Release package: the frontend is already built.'
} else {
  Info 'Decision: build the frontend. Looking for Node:'
  $nodeDir = Find-Node
  if (-not $nodeDir) { Info "Node $MinNode+ was not found; downloading portable Node."; $nodeDir = Install-PortableNode }
  $env:PATH = $nodeDir + [IO.Path]::PathSeparator + $env:PATH
  $npm = if ($IsWin) { Join-Path $nodeDir 'npm.cmd' } else { 'npm' }
  Info "Using Node $((& (Join-Path $nodeDir $(if ($IsWin) { 'node.exe' } else { 'node' })) -p 'process.versions.node').Trim()) from $nodeDir"
  [void](Invoke-Logged $npm @('--version'))
  Push-Location (Join-Path $Root 'frontend')
  try {
    $lockHash = (Get-FileHash -Algorithm SHA256 -Path 'package-lock.json').Hash
    $marker = Join-Path 'node_modules' '.setup-lock-hash'
    $installed = if (Test-Path $marker) { (Get-Content $marker -Raw).Trim() } else { '' }
    Info "package-lock.json hash $lockHash; installed packages were made from: $(if ($installed) { $installed } else { '(none)' })"
    if ($installed -ne $lockHash -or -not (Test-Path 'node_modules')) {
      Info 'Decision: install the frontend packages (package-lock.json changed or node_modules is missing).'
      if (Invoke-Logged $npm @('ci', '--no-audit', '--no-fund')) { Fail 'npm ci failed.' }
      Set-Content -Path $marker -Value $lockHash -Encoding ASCII
    } else {
      Info 'Decision: node_modules matches package-lock.json, packages are not reinstalled.'
    }
    Info 'Building the frontend'
    if (Invoke-Logged $npm @('run', 'build')) { Fail 'The frontend build failed.' }
  } finally { Pop-Location }
}
if (-not (Test-Path $Dist)) { Fail 'frontend\dist\index.html is missing after the build.' }
$distFiles = @(Get-ChildItem -Path (Join-Path $Root 'frontend\dist') -Recurse -File)
Info ('frontend\dist: {0} files, {1:N1} MB' -f $distFiles.Count, (($distFiles | Measure-Object Length -Sum).Sum / 1MB))

# ---- 4. Configuration ----------------------------------------------------------------------------

Step '4/6 Configuration'
$ConfigPath = Join-Path $Root 'outage-assessment.config.json'
if ((Test-Path $ConfigPath) -and -not $Force) {
  Info "Decision: the configuration exists and is left unchanged (use -Force to rewrite): $ConfigPath"
} else {
  if (-not $Database) { $Database = Join-Path $Root 'backend\data\outage-assessment.sqlite3' }
  $cfg = [ordered]@{ database = $Database; host = '127.0.0.1'; port = $Port }
  $cfg | ConvertTo-Json | Set-Content -Path $ConfigPath -Encoding UTF8
  Info "Written: $ConfigPath"
}
$cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
$Port = [int]$cfg.port
Info "Configuration in use: database = $($cfg.database); host = $($cfg.host); port = $($cfg.port)"
$dbDir = Split-Path $cfg.database
Info "Database folder: $dbDir (exists: $(Test-Path $dbDir))"
New-Item -ItemType Directory -Force -Path $dbDir | Out-Null

# ---- 5. Autostart (optional) ---------------------------------------------------------------------

Step '5/6 Autostart (optional)'
$Serve = Join-Path $Root 'scripts\serve.py'
if (-not $Autostart) {
  Info 'Decision: skipped. Add -Autostart to start the dashboard at every logon. Without it the PowerFactory script shows it.'
} elseif (-not $IsWin) {
  Info 'Autostart is only available on Windows.'
} else {
  $Pythonw = Join-Path $Venv 'Scripts\pythonw.exe'
  if (-not (Test-Path $Pythonw)) { $Pythonw = $VenvPython }
  $user = "$env:USERDOMAIN\$env:USERNAME"
  Info "Registering the logon task '$TaskName' for $user (run level: limited, no elevation)"
  Info "  program: $Pythonw"
  Info "  argument: $Serve"
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
  Info "A dashboard already answers on port $Port; no second server is started."
} else {
  $log = Join-Path $Tools 'selftest.log'
  New-Item -ItemType Directory -Force -Path $Tools | Out-Null
  $startArgs = @{ FilePath = $VenvPython; ArgumentList = @("`"$Serve`""); WorkingDirectory = $Root; PassThru = $true
                  RedirectStandardOutput = $log; RedirectStandardError = "$log.err" }
  if ($IsWin) { $startArgs.WindowStyle = 'Hidden' }
  Info "Starting the server for the test: $VenvPython `"$Serve`""
  Info "  output: $log (errors: $log.err)"
  $proc = Start-Process @startArgs
  Info "  process id $($proc.Id); waiting for http://127.0.0.1:$Port/api/health/ready (up to 60 attempts)"
  $ok = $false
  for ($i = 0; $i -lt 60 -and -not $ok -and -not $proc.HasExited; $i++) {
    try { $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health/ready" -TimeoutSec 2; $ok = ($r.status -eq 'ready') } catch { Start-Sleep -Milliseconds 500 }
    if (-not $ok -and ($i + 1) % 5 -eq 0) { Info "  attempt $($i + 1): not ready yet" }
  }
  Info "  ready: $ok after $i attempt(s); server process exited: $($proc.HasExited)"
  if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue; Info "  test server (process $($proc.Id)) stopped" }
  if (-not $ok) {
    foreach ($file in @($log, "$log.err")) {
      if ((Test-Path $file) -and (Get-Item $file).Length -gt 0) { Info "--- $file"; Get-Content $file -Tail 40 | ForEach-Object { Info "  $_" } }
    }
    Fail "The dashboard server did not start. See $log.err"
  }
  Info 'The dashboard server starts and answers.'
}

if ($Package) {
  Step 'Release package'
  if (Invoke-Logged $VenvPython @((Join-Path $Root 'scripts\package_release.py'))) { Fail 'The release package could not be built.' }
}

Show-Summary
if ($script:Transcript) { Write-Host "   Full log: $(Join-Path $Tools 'setup.log')"; try { Stop-Transcript | Out-Null } catch { } }

$StartScript = Join-Path $Root 'powerfactory\start_assessment.py'
Write-Host "`nReady." -ForegroundColor Green
Write-Host '  In PowerFactory add ONE script:'
Write-Host '    Data Manager > new object "ComPython" (external script file) > script file:'
Write-Host "    $StartScript" -ForegroundColor Yellow
Write-Host '  Activate the project and study case, then Execute. When the calculation is finished the script'
Write-Host "  starts the dashboard and opens it in your browser (http://127.0.0.1:$Port)."
