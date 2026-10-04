@echo off
rem Double-click to stop every dashboard server of this folder and release the results database.
rem Options are passed on, e.g.: stop-dashboard.cmd -DeleteDatabase
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-dashboard.ps1" %*
set "exitCode=%ERRORLEVEL%"
pause
exit /b %exitCode%
