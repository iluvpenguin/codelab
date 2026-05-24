@echo off
setlocal EnableDelayedExpansion

echo ============================================
echo  CodeLab Backend Builder
echo ============================================

:: ── Resolve paths safely (no %~dp0.. trailing-dot bug) ──
pushd "%~dp0"
set BACKEND_DIR=%CD%
popd

echo Backend dir: %BACKEND_DIR%
cd /d "%BACKEND_DIR%"

:: ── Detect Python 3.11 or 3.12 with pip ─────────────────
:: Must be 3.11 or 3.12 — pydantic-core won't build on 3.13/3.14
set PYTHON_CMD=

:: Try specific versions first (safest)
for %%V in (3.11 3.12 3.10) do (
    if "!PYTHON_CMD!"=="" (
        py -%%V -c "import pip" >nul 2>&1
        if !errorlevel!==0 (
            set PYTHON_CMD=py -%%V
            echo Found Python %%V via py launcher
        )
    )
)

:: Fallback: check if bare 'python' is an acceptable version
if "!PYTHON_CMD!"=="" (
    python -c "import sys, pip; v=sys.version_info; exit(0 if v.major==3 and v.minor in (10,11,12) else 1)" >nul 2>&1
    if !errorlevel!==0 (
        set PYTHON_CMD=python
        echo Found acceptable Python via 'python'
    )
)

if "!PYTHON_CMD!"=="" (
    echo ERROR: No compatible Python found (need 3.10, 3.11, or 3.12).
    echo Your default Python is 3.14 which is too new for pydantic-core.
    echo Install Python 3.11 from https://python.org ^(tick 'Add to PATH'^).
    echo Then re-run this script.
    exit /b 1
)

echo Using: !PYTHON_CMD!

:: ── Ensure routers folder exists ─────────────────────────
if not exist "routers" (
    echo ERROR: 'routers' folder not found in %BACKEND_DIR%
    echo Please copy the router files into H:\CodeIt\CodeIT\backend\routers\
    exit /b 1
)
if not exist "routers\__init__.py" (
    echo. > routers\__init__.py
)

:: ── Install dependencies ─────────────────────────────────
echo.
echo Installing requirements...
!PYTHON_CMD! -m pip install -r requirements.txt
if !errorlevel! neq 0 (
    echo ERROR: pip install failed
    exit /b 1
)

:: ── Install PyInstaller ──────────────────────────────────
echo.
echo Installing PyInstaller...
!PYTHON_CMD! -m pip install pyinstaller
if !errorlevel! neq 0 (
    echo ERROR: PyInstaller install failed
    exit /b 1
)

:: ── Build the executable ─────────────────────────────────
echo.
echo Building codelab-server (--onedir)...
!PYTHON_CMD! -m PyInstaller codelab-server.spec --clean --noconfirm
if !errorlevel! neq 0 (
    echo ERROR: PyInstaller build failed
    exit /b 1
)

:: ── Copy folder to electron resources ────────────────────
set ELECTRON_RESOURCES=%BACKEND_DIR%\..\electron-codeit\resources
if exist "%ELECTRON_RESOURCES%" (
    echo.
    echo Copying codelab-server folder to electron resources...
    if exist "%ELECTRON_RESOURCES%\codelab-server" (
        rmdir /s /q "%ELECTRON_RESOURCES%\codelab-server"
    )
    xcopy /E /I /Q "%BACKEND_DIR%\dist\codelab-server" "%ELECTRON_RESOURCES%\codelab-server"
    if !errorlevel!==0 (
        echo Copied successfully.
    ) else (
        echo WARNING: Copy failed - copy dist\codelab-server folder manually.
    )
) else (
    echo NOTE: electron-codeit\resources not found - copy dist\codelab-server folder manually.
)

echo.
echo ============================================
echo  Backend build complete!
echo  Output: %BACKEND_DIR%\dist\codelab-server\
echo ============================================
endlocal
