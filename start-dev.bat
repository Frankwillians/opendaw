@echo off
cd /d "%~dp0"
echo Iniciando servidor de desenvolvimento OpenDAW...
echo.
npm run dev -- --port 5173 --host 0.0.0.0
pause