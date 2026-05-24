# codelab-server.spec
# Use this instead of the CLI for reproducible builds:
#   pyinstaller codelab-server.spec
#
# --onedir mode: produces a folder instead of a single exe.
# This means Windows Firewall only prompts ONCE (stable path),
# instead of every run (--onefile extracts to a new random temp folder each time).

import sys
from PyInstaller.utils.hooks import collect_data_files

block_cipher = None

hidden_imports = [
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.asyncio",
    "uvicorn.loops.uvloop",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.http.httptools_impl",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.protocols.websockets.websockets_impl",
    "uvicorn.protocols.websockets.wsproto_impl",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
    "fastapi",
    "fastapi.middleware",
    "fastapi.middleware.cors",
    "aiofiles",
    "pydantic",
    "dotenv",
    "email.mime.text",
    "anthropic",
    "keyring",
    "keyring.backends",
    "keyring.backends.Windows",
]

datas = [
    ("routers", "routers"),
    (".env", "."),          # bundled so the packaged exe reads it from its own dir
]

a = Analysis(
    ["server.py"],
    pathex=["."],
    binaries=[],
    datas=datas,
    hiddenimports=hidden_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],                         # no a.binaries/a.zipfiles/a.datas here (onedir mode)
    name="codelab-server",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="codelab-server",
)
