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
taskkill /F /IM codeit-server.exe 2>nul
taskkill /F /IM CodeLab.exe 2>nul
timeout /t 2 /nobreak >nul

:: Step 1: Build Python backend
echo.
echo [1/4] Building backend...
cd /d "%BACKEND%"
py -3.11 -m pip install pyinstaller --quiet
py -3.11 -m PyInstaller codeit-server.spec --clean --noconfirm
if !errorlevel! neq 0 ( echo ERROR: Backend build failed & exit /b 1 )
copy /Y "%BACKEND%\dist\codeit-server.exe" "%ELECTRON%\resources\codeit-server.exe"
echo Backend built and copied.

:: Step 2: Build React frontend
echo.
echo [2/4] Building frontend...
cd /d "%FRONTEND%"
call yarn build
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
