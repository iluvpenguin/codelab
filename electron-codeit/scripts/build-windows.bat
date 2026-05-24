@echo off
setlocal EnableDelayedExpansion

echo ============================================
echo  CodeIT Desktop - Full Build Script
echo ============================================

:: ── Resolve root path ────────────────────────────────────────────────────────
pushd "%~dp0\..\.."
set ROOT_DIR=%CD%
popd

set BACKEND_DIR=%ROOT_DIR%\backend
set FRONTEND_DIR=%ROOT_DIR%\frontend
set ELECTRON_DIR=%ROOT_DIR%\electron-codeit

echo Root:     %ROOT_DIR%
echo Backend:  %BACKEND_DIR%
echo Frontend: %FRONTEND_DIR%
echo Electron: %ELECTRON_DIR%
echo.

:: ── Detect Python 3.11 ───────────────────────────────────────────────────────
set PYTHON_CMD=
for %%V in (3.11 3.12 3.10) do (
    if "!PYTHON_CMD!"=="" (
        py -%%V -c "import pip" >nul 2>&1
        if !errorlevel!==0 (
            set PYTHON_CMD=py -%%V
            echo Found Python %%V
        )
    )
)
if "!PYTHON_CMD!"=="" (
    echo ERROR: No compatible Python found. Install Python 3.11 from python.org
    exit /b 1
)

:: ── Step 1: Build Python backend ─────────────────────────────────────────────
echo.
echo [1/4] Building backend...
cd /d "%BACKEND_DIR%"

!PYTHON_CMD! -m pip install -r requirements.txt --quiet
if !errorlevel! neq 0 ( echo ERROR: pip install failed & exit /b 1 )

!PYTHON_CMD! -m pip install pyinstaller --quiet
if !errorlevel! neq 0 ( echo ERROR: PyInstaller install failed & exit /b 1 )

!PYTHON_CMD! -m PyInstaller codeit-server.spec --clean --noconfirm
if !errorlevel! neq 0 ( echo ERROR: PyInstaller build failed & exit /b 1 )

echo Backend built successfully.

:: ── Step 2: Copy backend exe to electron resources ───────────────────────────
echo.
echo [2/4] Copying backend exe...
if not exist "%ELECTRON_DIR%\resources" mkdir "%ELECTRON_DIR%\resources"
copy /Y "%BACKEND_DIR%\dist\codeit-server.exe" "%ELECTRON_DIR%\resources\codeit-server.exe"
if !errorlevel! neq 0 ( echo ERROR: Failed to copy backend exe & exit /b 1 )
echo Copied codeit-server.exe to electron resources.

:: ── Step 3: Build React frontend ─────────────────────────────────────────────
echo.
echo [3/4] Building frontend...
cd /d "%FRONTEND_DIR%"

call yarn install
if !errorlevel! neq 0 ( echo ERROR: yarn install failed & exit /b 1 )

set REACT_APP_BACKEND_URL=http://localhost:58483
call yarn build
if !errorlevel! neq 0 ( echo ERROR: yarn build failed & exit /b 1 )

echo Frontend built successfully.

:: ── Step 4: Build Electron app ───────────────────────────────────────────────
echo.
echo [4/4] Building Electron app...
cd /d "%ELECTRON_DIR%"

call npm install
if !errorlevel! neq 0 ( echo ERROR: npm install failed & exit /b 1 )

set CSC_IDENTITY_AUTO_DISCOVERY=false
call npm run build
if !errorlevel! neq 0 ( echo ERROR: Electron build failed & exit /b 1 )

echo.
echo ============================================
echo  Build complete!
echo  Output: %ELECTRON_DIR%\dist\
echo  - CodeIT Desktop Setup 1.0.0.exe  (installer)
echo  - CodeIT-Desktop-Portable.exe     (portable)
echo ============================================
endlocal
