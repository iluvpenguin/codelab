@echo off
setlocal EnableDelayedExpansion
echo ============================================
echo  CodeLab - Full Build
echo ============================================

set ROOT=H:\CodeIt\CodeIT
set BACKEND=%ROOT%\backend
set FRONTEND=%ROOT%\frontend
set ELECTRON=%ROOT%\electron-codeit

:: Step 0: Kill any running instances
echo.
echo [0/4] Killing running instances...
taskkill /F /IM codelab-server.exe 2>nul
taskkill /F /IM CodeLab.exe 2>nul
timeout /t 2 /nobreak >nul

:: Step 1: Build Python backend (--onedir so Firewall only asks once)
echo.
echo [1/4] Building backend...
cd /d "%BACKEND%"
call build-backend.bat
if !errorlevel! neq 0 ( echo ERROR: Backend build failed & exit /b 1 )

:: Step 2: Build React frontend
echo.
echo [2/4] Building frontend...
cd /d "%FRONTEND%"
call npm run build
if !errorlevel! neq 0 ( echo ERROR: Frontend build failed & exit /b 1 )
echo Frontend built.

:: Step 3: Build Electron
echo.
echo [3/4] Building Electron app...
cd /d "%ELECTRON%"
call npm install
set CSC_IDENTITY_AUTO_DISCOVERY=false
call npm run build
if !errorlevel! neq 0 ( echo ERROR: Electron build failed & exit /b 1 )

echo.
echo ============================================
echo  Build complete!
echo  Output: %ELECTRON%\dist\
echo  - CodeLab Setup 1.0.0.exe
echo  - CodeLab-Portable.exe
echo ============================================
endlocal
