# Independent Windows UI: remains responsive while setup installs Python packages and builds the frontend.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$PythonVersion, [string]$Python, [switch]$RebuildFrontend)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$Root = Split-Path $PSScriptRoot
$Tools = Join-Path $Root '.tools'
New-Item -ItemType Directory -Force -Path $Tools | Out-Null
$lock = $null
try { $lock = [IO.File]::Open((Join-Path $Tools 'first-run.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
catch {
  [void][Windows.Forms.MessageBox]::Show('Die Einrichtung läuft bereits. Bitte warten und danach das PowerFactory-Skript erneut starten.', 'Outage Assessment')
  exit 1
}
$form = New-Object Windows.Forms.Form
$form.Text = 'Outage Assessment - Erste Einrichtung'
$form.ClientSize = New-Object Drawing.Size(660, 330)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.ControlBox = $false
$intro = New-Object Windows.Forms.Label
$intro.Location = New-Object Drawing.Point(20, 18)
$intro.Size = New-Object Drawing.Size(620, 48)
$intro.Text = "Das Dashboard wird automatisch vorbereitet. Downloads können einige Minuten dauern.`r`nNach Abschluss öffnet sich der Case Manager."
$status = New-Object Windows.Forms.Label
$status.Location = New-Object Drawing.Point(20, 76)
$status.Size = New-Object Drawing.Size(620, 24)
$status.Text = 'Einrichtung wird gestartet ...'
$bar = New-Object Windows.Forms.ProgressBar
$bar.Location = New-Object Drawing.Point(20, 106)
$bar.Size = New-Object Drawing.Size(620, 24)
$bar.Style = 'Continuous'
$activity = New-Object Windows.Forms.ProgressBar
$activity.Location = New-Object Drawing.Point(20, 135)
$activity.Size = New-Object Drawing.Size(620, 5)
$activity.Style = 'Marquee'
$details = New-Object Windows.Forms.TextBox
$details.Location = New-Object Drawing.Point(20, 154)
$details.Size = New-Object Drawing.Size(620, 122)
$details.Multiline = $true
$details.ReadOnly = $true
$details.ScrollBars = 'Vertical'
$details.Text = "Log: $(Join-Path $Tools 'setup.log')"
$note = New-Object Windows.Forms.Label
$note.Location = New-Object Drawing.Point(20, 288)
$note.Size = New-Object Drawing.Size(620, 24)
$note.Text = 'Bitte dieses Fenster und PowerFactory während der Einrichtung geöffnet lassen.'
$form.Controls.AddRange(@($intro, $status, $bar, $activity, $details, $note))
$form.Show()
[Windows.Forms.Application]::DoEvents()
$code = 1
try {
  $progress = Join-Path $Tools 'first-run.progress.json'
  Remove-Item $progress -ErrorAction SilentlyContinue
  $out = Join-Path $Tools 'first-run.stdout.log'
  $err = Join-Path $Tools 'first-run.stderr.log'
  # Windows paths cannot contain double quotes. Quote each path explicitly; never invoke through a shell string.
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$(Join-Path $Root 'setup.ps1')`"",
                 '-PythonVersion', $PythonVersion, '-ProgressFile', "`"$progress`"")
  if ($RebuildFrontend) { $arguments += '-RebuildFrontend' }
  if ($Python) { $arguments += @('-Python', "`"$Python`"") }
  $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WorkingDirectory $Root -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
  $null = $proc.Handle # Keep the process handle so ExitCode remains available after the process exits.
  do {
    if (Test-Path $progress) {
      try {
        $p = Get-Content $progress -Raw -Encoding UTF8 | ConvertFrom-Json
        $status.Text = $p.message
        $bar.Value = [Math]::Max(0, [Math]::Min(100, [int]$p.percent))
      } catch { } # The writer may currently be replacing the progress file.
    }
    if (Test-Path $out) {
      try { $details.Text = (Get-Content $out -Tail 6) -join "`r`n" } catch { }
    }
    [Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 100
    $proc.Refresh()
  } while (-not $proc.HasExited)
  $proc.WaitForExit()
  $code = $proc.ExitCode
  if ($null -eq $code) { throw 'Der Abschlussstatus der Einrichtung konnte nicht gelesen werden.' }
  if ($code -ne 0) {
    $reason = if (Test-Path $err) { (Get-Content $err -Tail 8) -join "`r`n" } else { '' }
    if (-not $reason) { $reason = $details.Text }
    if ($p -and $p.status -eq 'failed') { $reason = $p.message + "`r`n" + $reason }
    throw "Einrichtung fehlgeschlagen.`r`n$reason`r`nDetails: $(Join-Path $Tools 'setup.log')"
  }
  $bar.Value = 100
  $status.Text = 'Einrichtung abgeschlossen. Der Case Manager wird geöffnet.'
  [Windows.Forms.Application]::DoEvents()
} catch {
  $code = 1
  [void][Windows.Forms.MessageBox]::Show($form, $_.Exception.Message, 'Outage Assessment - Einrichtung fehlgeschlagen', 'OK', 'Error')
} finally {
  $form.Close()
  $form.Dispose()
  if ($lock) { $lock.Dispose() }
}
exit $code
