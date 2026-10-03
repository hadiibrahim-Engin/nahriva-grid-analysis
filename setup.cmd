@echo off
rem Double-click to set everything up (Python, backend, frontend, configuration). No administrator rights needed.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
if errorlevel 1 pause
