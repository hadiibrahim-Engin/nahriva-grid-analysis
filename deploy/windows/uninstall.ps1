<# Entfernt Autostart und Firewall-Regel. Ergebnisdatenbank und Programmordner bleiben unverändert. #>
$ErrorActionPreference = 'Continue'
$TaskName = 'OutageAssessmentDashboard'
$RuleName = 'Outage Assessment Dashboard'
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
Write-Host "Aufgabe und Firewall-Regel entfernt (sofern vorhanden). Laufende Server-Prozesse ggf. im Task-Manager beenden (pythonw.exe)."
