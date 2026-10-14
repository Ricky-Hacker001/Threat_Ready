@echo off
rem Double-click to set up and run ThreatReady locally.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
