@echo off
rem Shield Browser 실행 런처 — 더블클릭으로 실행
cd /d "%~dp0"
start "" "node_modules\electron\dist\electron.exe" .
