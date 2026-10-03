<# Removes the optional autostart task. The results database and the project folder stay unchanged. #>
$ErrorActionPreference = 'Continue'
$TaskName = 'OutageAssessmentDashboard'
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "Autostart task removed (if it existed). A running server can be ended in the Task Manager (pythonw.exe)."
