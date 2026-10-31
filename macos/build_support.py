"""Local build helpers. No downloads, shell evaluation, or user configuration."""
from pathlib import Path
import hashlib
import os
import platform
import plistlib
import struct
import subprocess
import sys
import tempfile

SOURCE = Path(__file__).resolve().parents[1]
BUILD = SOURCE / "build"
ELECTRON_VERSION = "45.1.0"
BUNDLE_ID = "io.github.mushan08.claude-chan-pet.local"
# Official v45.1.0 darwin-arm64 release, verified from its published archive.
# Tree hash: sorted (relative path, F/L type, SHA-256 of file/link-target bytes),
# serialized as type + NUL + UTF-8 path + NUL + raw SHA-256 digest per entry.
ELECTRON_ARCHIVE_SHA256 = "002b71efcf90e247317d3da486f2d4e51860e9c2889d49f33e229ab2268b0f3b"
ELECTRON_TREE_SHA256 = "a113bc9031e61a7df47b55733d673db75533cc6448fd6f1e462d8d0cde19559b"


def require_platform():
    if sys.platform != "darwin" or platform.machine() != "arm64":
        raise ValueError("This local build supports Apple Silicon macOS only")
    version = tuple(int(part) for part in platform.mac_ver()[0].split(".")[:2])
    if version < (13, 0):
        raise ValueError("Electron 45 requires macOS 13 or later")


def app_info(app):
    with (Path(app) / "Contents/Info.plist").open("rb") as handle:
        return plistlib.load(handle)


def require_arm64(executable):
    with Path(executable).open("rb") as handle:
        header = handle.read(8)
    if len(header) != 8 or struct.unpack("<II", header) != (0xFEEDFACF, 0x0100000C):
        raise ValueError("Expected a thin arm64 Mach-O executable")


def electron_runtime():
    explicit = os.environ.get("ELECTRON_RUNTIME")
    if explicit:
        app = Path(explicit).expanduser()
        if not app.is_absolute():
            raise ValueError("ELECTRON_RUNTIME must be an explicit absolute path")
        app = app.resolve(strict=True)
        if app.name != "Electron.app":
            app = app / "Electron.app"
    else:
        app = SOURCE / "node_modules/electron/dist/Electron.app"
    if not app.is_dir():
        raise ValueError("Electron.app is missing; run npm install then npm run runtime:install, or set ELECTRON_RUNTIME to a trusted official runtime")
    info = app_info(app)
    if info.get("CFBundleShortVersionString") != ELECTRON_VERSION:
        raise ValueError("Expected official Electron " + ELECTRON_VERSION)
    executable = app / "Contents/MacOS" / info.get("CFBundleExecutable", "Electron")
    require_arm64(executable)
    # Electron's developer distribution is linker/ad-hoc signed without a full
    # bundle resource seal. Verify the exact official tree instead of treating
    # it as an already packaged/notarized consumer app.
    root = app.resolve()
    entries = []
    for entry in app.rglob("*"):
        if entry.is_symlink():
            try:
                entry.resolve(strict=True).relative_to(root)
            except (ValueError, FileNotFoundError):
                raise ValueError("Electron runtime contains an external or broken symlink") from None
            entries.append((entry.relative_to(app).as_posix(), b"L", os.readlink(entry).encode()))
        elif entry.is_file():
            entries.append((entry.relative_to(app).as_posix(), b"F", entry.read_bytes()))
    digest = hashlib.sha256()
    for name, kind, data in sorted(entries):
        digest.update(kind + b"\0" + name.encode() + b"\0" + hashlib.sha256(data).digest())
    if digest.hexdigest() != ELECTRON_TREE_SHA256:
        raise ValueError("Runtime bytes differ from the pinned official Electron arm64 distribution")
    return app


def build_launcher():
    require_platform()
    BUILD.mkdir(parents=True, exist_ok=True)
    destination = BUILD / "ClaudePetLauncher"
    if destination.is_symlink():
        raise ValueError("Refusing a symlinked launcher output")
    with tempfile.TemporaryDirectory(prefix=".launcher-build-", dir=BUILD) as temporary:
        output = Path(temporary) / "ClaudePetLauncher"
        subprocess.run(["/usr/bin/xcrun", "swiftc", "-module-cache-path", str(BUILD / "swift-cache"),
                        "-o", str(output), str(SOURCE / "macos/ClaudePetLauncher.swift")], check=True)
        require_arm64(output)
        output.chmod(0o755)
        os.replace(output, destination)
    return destination
