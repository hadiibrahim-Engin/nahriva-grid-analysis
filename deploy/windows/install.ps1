<#
.SYNOPSIS
  Einmalige Einrichtung des Dashboards auf dem PowerFactory-PC.

.DESCRIPTION
  Legt die Python-Umgebung an, schreibt die Konfiguration, öffnet den Port für das lokale Netz
  und richtet den Autostart ein. Danach ist das Dashboard dauerhaft unter http://<PC-Name>:<Port>
  erreichbar - auch ohne PowerFactory. Das PowerFactory-Skript speichert nur noch Ergebnisse.

  Als Administrator ausführen, damit Firewall-Regel und Aufgabe angelegt werden können
  (ohne Administrator wird beides übersprungen und der Befehl dafür ausgegeben).

.PARAMETER Database   Pfad der Ergebnisdatenbank (Standard: backend\data\outage-assessment.sqlite3)
.PARAMETER Port       Port des Dashboards (Standard 8765)
.PARAMETER Python     Python 3.12 oder neuer (Standard: automatisch suchen)
.PARAMETER Wheelhouse Ordner mit vorab geladenen Paketen für Rechner ohne Internet
.PARAMETER NoAutostart / NoFirewall   Teilschritte überspringen
#>
[CmdletBinding()]
param(
  [string]$Database,
  [int]$Port = 8765,
  [string]$Python,
  [string]$Wheelhouse,
  [switch]$NoAutostart,
  [switch]$NoFirewall,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$TaskName = 'OutageAssessmentDashboard'
$RuleName = 'Outage Assessment Dashboard'
$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }

Step '1/6 Python suchen'
function Test-Python($exe, $prefix) {
  try {
    $v = & $exe @prefix -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
    if ($LASTEXITCODE -eq 0 -and [version]$v -ge [version]'3.12') { return @($exe) + $prefix }
  } catch { }
  return $null
}
$py = @()
if ($Python) { $py = @(Test-Python $Python @()) }
if (-not $py) { $py = @(Test-Python 'py' @('-3.12')) }
if (-not $py) { $py = @(Test-Python 'python' @()) }
if (-not $py) { throw 'Python 3.12 oder neuer wurde nicht gefunden. Von python.org installieren (Haken bei "Add python.exe to PATH") oder -Python angeben.' }
Write-Host "Verwende: $($py -join ' ')"

Step '2/6 Python-Umgebung anlegen und Pakete installieren'
$Venv = Join-Path $Root 'backend\.venv'
$VenvPython = Join-Path $Venv 'Scripts\python.exe'
if (-not (Test-Path $VenvPython)) {
  $pyArgs = @()
  if ($py.Length -gt 1) { $pyArgs = $py[1..($py.Length - 1)] }
  & $py[0] @pyArgs -m venv $Venv
  if ($LASTEXITCODE) { throw 'venv konnte nicht angelegt werden.' }
}
$pipArgs = @('-m', 'pip', 'install', '--disable-pip-version-check', (Join-Path $Root 'backend'))
if ($Wheelhouse) { $pipArgs = @('-m', 'pip', 'install', '--disable-pip-version-check', '--no-index', '--find-links', $Wheelhouse, (Join-Path $Root 'backend')) }
& $VenvPython @pipArgs
if ($LASTEXITCODE) { throw 'Paketinstallation fehlgeschlagen (kein Internet? Dann -Wheelhouse verwenden, siehe docs/DEPLOYMENT.md).' }

Step '3/6 Frontend prüfen'
if (-not (Test-Path (Join-Path $Root 'frontend\dist\index.html'))) {
  throw 'frontend\dist fehlt. Das Release-Paket enthält den fertigen Build; sonst auf einem Entwicklungsrechner "npm ci; npm run build" ausführen und den Ordner kopieren.'
}

Step '4/6 Konfiguration schreiben'
$ConfigPath = Join-Path $Root 'outage-assessment.config.json'
if ((Test-Path $ConfigPath) -and -not $Force) {
  Write-Host "Vorhanden, bleibt unverändert: $ConfigPath (mit -Force neu schreiben)"
} else {
  if (-not $Database) { $Database = Join-Path $Root 'backend\data\outage-assessment.sqlite3' }
  $cfg = [ordered]@{ database = $Database; host = '0.0.0.0'; port = $Port }
  $cfg | ConvertTo-Json | Set-Content -Path $ConfigPath -Encoding UTF8
  Write-Host "Geschrieben: $ConfigPath"
}
$cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
$Port = [int]$cfg.port
New-Item -ItemType Directory -Force -Path (Split-Path $cfg.database) | Out-Null

Step '5/6 Firewall (nur lokales Netz)'
$FirewallCommand = "New-NetFirewallRule -DisplayName '$RuleName' -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -RemoteAddress LocalSubnet -Profile Domain,Private"
if ($NoFirewall) { Write-Host 'Übersprungen.' }
elseif (-not $IsAdmin) { Write-Warning "Kein Administrator. Als Administrator ausführen: $FirewallCommand" }
else {
  Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  Invoke-Expression $FirewallCommand | Out-Null
  Write-Host "Port $Port ist für das lokale Netz geöffnet."
}

Step '6/6 Autostart einrichten'
$Pythonw = Join-Path $Venv 'Scripts\pythonw.exe'
if (-not (Test-Path $Pythonw)) { $Pythonw = $VenvPython }
$Serve = Join-Path $Root 'scripts\serve.py'
if ($NoAutostart) { Write-Host 'Übersprungen.' }
else {
  # Run as the user who also runs PowerFactory, so both open the same database files with the same rights.
  $action = New-ScheduledTaskAction -Execute $Pythonw -Argument "`"$Serve`"" -WorkingDirectory $Root
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $settings = New-ScheduledTaskSettingsSet -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  try {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Aufgabe '$TaskName' angelegt und gestartet (startet bei jeder Anmeldung dieses Benutzers)."
  } catch {
    Write-Warning "Autostart konnte nicht eingerichtet werden: $($_.Exception.Message). Als Administrator erneut ausführen."
  }
}

Step 'Selbsttest'
$ready = $false
for ($i = 0; $i -lt 40 -and -not $ready; $i++) {
  try { $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health/ready" -TimeoutSec 2; $ready = ($r.status -eq 'ready') } catch { Start-Sleep -Milliseconds 500 }
}
if ($ready) { Write-Host 'Dashboard läuft.' -ForegroundColor Green } else { Write-Warning "Dashboard antwortet noch nicht. Log: $(Join-Path (Split-Path $cfg.database) ([IO.Path]::GetFileNameWithoutExtension($cfg.database) + '.server.log'))" }

Write-Host "`nFertig. Adressen für andere PCs im Netz:" -ForegroundColor Green
Write-Host "  http://$($env:COMPUTERNAME):$Port"
Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | ForEach-Object { Write-Host "  http://$($_.IPAddress):$Port" }
Write-Host "`nNächster Schritt in PowerFactory: externes ComPython-Skript auf powerfactory\start_assessment.py anlegen und ausführen."
