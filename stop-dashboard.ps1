<#
.SYNOPSIS
  Stops every dashboard server of this project so that the results database is released
  (for example to delete or replace it). Needs no administrator rights.

.DESCRIPTION
  1. Stops the autostart task 'OutageAssessmentDashboard' (it would otherwise start the server again).
     With -DisableAutostart the task is also disabled until it is enabled again (Task Scheduler or
     setup.ps1 -Autostart).
  2. Stops a Windows service of that name, if one was set up by IT.
  3. Finds the server processes of this project: the one recorded in <database>.dashboard.json
     (started by the PowerFactory script), the one listening on the dashboard port, and every Python
     process that runs scripts\serve.py or "uvicorn app.main:app" from this folder. Only Python
     processes of this project are ever stopped.
  4. Checks that the database file is no longer locked.
  5. Optional (-DeleteDatabase): deletes the database with its -wal/-shm files and the dashboard
     state files, after a confirmation (or without one with -Force).

  Every step and every process is reported. -DryRun only shows what would be stopped.

.PARAMETER Database          Results database (default: from outage-assessment.config.json)
.PARAMETER Port              Dashboard port (default: from the configuration, else 8765)
.PARAMETER DisableAutostart  Also disable the autostart task, so it does not start again at the next logon
.PARAMETER DeleteDatabase    Delete the results database after the servers have stopped
.PARAMETER Force             Delete without asking
.PARAMETER DryRun            Only show what would be stopped; change nothing

.EXAMPLE
  .\stop-dashboard.ps1
.EXAMPLE
  .\stop-dashboard.ps1 -DeleteDatabase
#>
[CmdletBinding()]
param(
  [string]$Database,
  [int]$Port,
  [switch]$DisableAutostart,
  [switch]$DeleteDatabase,
  [switch]$Force,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$TaskName = 'OutageAssessmentDashboard'
$script:Failures = 0

function Stamp { '{0:HH:mm:ss}' -f (Get-Date) }
function Step($text) { Write-Host "`n[$(Stamp)] == $text" -ForegroundColor Cyan }
function Info($text) { Write-Host "   [$(Stamp)] $text" }
function Warn($text) { Write-Host "   [$(Stamp)] $text" -ForegroundColor Yellow; $script:Failures++ }

if ($env:OS -ne 'Windows_NT') {
  Write-Host 'This script is for Windows. Elsewhere stop the server with Ctrl+C or: pkill -f "uvicorn app.main:app"'
  exit 1
}
if ($DryRun) { Write-Host 'Dry run: nothing is changed.' -ForegroundColor Yellow }

# ---- Configuration ------------------------------------------------------------------------------

Step '1/5 Configuration'
$ConfigPath = Join-Path $Root 'outage-assessment.config.json'
$cfg = $null
if (Test-Path $ConfigPath) {
  try { $cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json; Info "Read $ConfigPath" }
  catch { Warn "Could not read $ConfigPath ($($_.Exception.Message)); using defaults." }
} else { Info 'No configuration file; using defaults.' }
if (-not $Database) { $Database = if ($cfg -and $cfg.database) { [string]$cfg.database } else { Join-Path $Root 'backend\data\outage-assessment.sqlite3' } }
if (-not [IO.Path]::IsPathRooted($Database)) { $Database = Join-Path $Root $Database }
if (-not $Port) { $Port = if ($cfg -and $cfg.port) { [int]$cfg.port } else { 8765 } }
Info "Database: $Database (exists: $(Test-Path $Database))"
Info "Port: $Port"

# ---- Autostart task and service ------------------------------------------------------------------

Step '2/5 Autostart task and service'
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
  Info "No autostart task '$TaskName'."
} else {
  Info "Autostart task '$TaskName': state $($task.State)"
  if ($task.State -eq 'Running') {
    if ($DryRun) { Info 'Would stop the task.' }
    else {
      try { Stop-ScheduledTask -TaskName $TaskName; Info 'Task stopped (it starts again at the next logon unless -DisableAutostart is given).' }
      catch { Warn "The task could not be stopped: $($_.Exception.Message)" }
    }
  }
  if ($DisableAutostart -and $task.State -ne 'Disabled') {
    if ($DryRun) { Info 'Would disable the task.' }
    else {
      try { Disable-ScheduledTask -TaskName $TaskName | Out-Null; Info 'Task disabled. Enable it again with: Enable-ScheduledTask -TaskName OutageAssessmentDashboard' }
      catch { Warn "The task could not be disabled: $($_.Exception.Message)" }
    }
  }
}
$service = Get-Service -Name $TaskName -ErrorAction SilentlyContinue
if (-not $service) {
  Info "No Windows service '$TaskName'."
} else {
  Info "Windows service '$TaskName': $($service.Status)"
  if ($service.Status -ne 'Stopped') {
    if ($DryRun) { Info 'Would stop the service.' }
    else {
      try { Stop-Service -Name $TaskName -Force; Info 'Service stopped.' }
      catch { Warn "The service could not be stopped ($($_.Exception.Message)). A service set up by IT may need IT to stop it." }
    }
  }
}

# ---- Server processes ---------------------------------------------------------------------------

Step '3/5 Dashboard server processes'
$rootPattern = [regex]::Escape($Root.TrimEnd('\'))
$candidates = @{}
function Add-Candidate($id, $reason) {
  if (-not $id -or $id -eq $PID) { return }
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $id" -ErrorAction SilentlyContinue
  if (-not $proc) { Info "Process $id ($reason) is no longer running."; return }
  $line = [string]$proc.CommandLine
  $isPython = $proc.Name -match '^pythonw?(\d+(\.\d+)?)?\.exe$'
  $isOurs = ($line -match $rootPattern) -or ($line -match 'uvicorn.*app\.main:app') -or ($line -match 'scripts[\\/]serve\.py')
  if (-not ($isPython -and $isOurs)) {
    Info "Process $id ($($proc.Name), $reason) is not a dashboard server of this project and is left alone."
    if ($line) { Info "  command line: $line" }
    return
  }
  if (-not $candidates.ContainsKey($id)) {
    $candidates[$id] = [pscustomobject]@{ Id = $id; Name = $proc.Name; Reason = $reason; Line = $line }
  } else { $candidates[$id].Reason += ", $reason" }
}

$stateFile = [IO.Path]::ChangeExtension($Database, '.dashboard.json')
if (Test-Path $stateFile) {
  try {
    $state = Get-Content $stateFile -Raw | ConvertFrom-Json
    Info "State file $stateFile names process $($state.pid) at $($state.url)"
    Add-Candidate ([int]$state.pid) 'started by the PowerFactory script'
  } catch { Info "State file $stateFile is not readable; ignored." }
} else { Info 'No state file of a server started by the PowerFactory script.' }

$listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
if ($listeners.Count -eq 0) { Info "Nothing listens on port $Port." }
foreach ($conn in $listeners) {
  Info "Port $Port is held by process $($conn.OwningProcess) ($($conn.LocalAddress))"
  Add-Candidate ([int]$conn.OwningProcess) "listens on port $Port"
}

$pythons = @(Get-CimInstance Win32_Process -Filter "Name LIKE 'python%'" -ErrorAction SilentlyContinue)
Info "$($pythons.Count) Python process(es) on this PC checked."
foreach ($proc in $pythons) {
  $line = [string]$proc.CommandLine
  if ($line -match $rootPattern -and ($line -match 'serve\.py' -or $line -match 'uvicorn.*app\.main:app')) {
    Add-Candidate ([int]$proc.ProcessId) 'dashboard server of this folder'
  }
}

if ($candidates.Count -eq 0) {
  Info 'No dashboard server of this project is running.'
} else {
  foreach ($c in $candidates.Values) {
    Info "Server process $($c.Id) ($($c.Name)): $($c.Reason)"
    Info "  command line: $($c.Line)"
    if ($DryRun) { Info '  would be stopped.'; continue }
    try {
      Stop-Process -Id $c.Id -Force
      $gone = $false
      for ($i = 0; $i -lt 20 -and -not $gone; $i++) {
        Start-Sleep -Milliseconds 250
        $gone = -not (Get-Process -Id $c.Id -ErrorAction SilentlyContinue)
      }
      if ($gone) { Info '  stopped.' } else { Warn "  process $($c.Id) is still running." }
    } catch { Warn "  could not be stopped: $($_.Exception.Message)" }
  }
}

# ---- Database lock ------------------------------------------------------------------------------

Step '4/5 Database lock'
function Test-Unlocked($file) {
  if (-not (Test-Path $file)) { return $true }
  try { $stream = [IO.File]::Open($file, 'Open', 'ReadWrite', 'None'); $stream.Close(); return $true }
  catch { return $false }
}
$files = @($Database, "$Database-wal", "$Database-shm") | Where-Object { Test-Path $_ }
if ($files.Count -eq 0) { Info 'The database does not exist.' }
$locked = @()
foreach ($file in $files) {
  if (Test-Unlocked $file) { Info "Free: $file" } else { $locked += $file; Warn "Still locked: $file" }
}
if ($locked.Count -gt 0) {
  Warn 'Another program still has the database open: the PowerFactory script, a database viewer (e.g. DB Browser for SQLite), a backup or antivirus scan, or a dashboard of another project folder. Close it and run this script again.'
}

# ---- Delete (optional) --------------------------------------------------------------------------

Step '5/5 Delete the database (optional)'
if (-not $DeleteDatabase) {
  Info 'Skipped. Add -DeleteDatabase to delete the results database.'
} elseif ($locked.Count -gt 0) {
  Warn 'Not deleted: the database is still locked.'
} else {
  $targets = @($Database, "$Database-wal", "$Database-shm", $stateFile, [IO.Path]::ChangeExtension($Database, '.dashboard.log')) | Where-Object { Test-Path $_ }
  if ($targets.Count -eq 0) { Info 'Nothing to delete.' }
  else {
    $targets | ForEach-Object { Info "To delete: $_" }
    $go = $Force -or $DryRun
    if (-not $go) { $go = (Read-Host 'Delete these files permanently? Type YES') -ceq 'YES' }
    if ($DryRun) { Info 'Would delete them.' }
    elseif (-not $go) { Info 'Not deleted.' }
    else {
      foreach ($file in $targets) {
        try { Remove-Item -LiteralPath $file -Force; Info "Deleted: $file" } catch { Warn "Could not delete $($file): $($_.Exception.Message)" }
      }
      Info 'The PowerFactory script creates a new, empty database at its next run.'
    }
  }
}

if ($script:Failures -gt 0) {
  Write-Host "`nFinished with $($script:Failures) problem(s); see the yellow lines above." -ForegroundColor Yellow
  exit 1
}
Write-Host "`nDone. Start the dashboard again with the PowerFactory script, scripts\serve.py or at the next logon (autostart)." -ForegroundColor Green
