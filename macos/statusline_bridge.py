#!/usr/bin/python3
"""Local, credential-free Claude Code statusLine bridge (Python 3.9+).

Only four numeric rate-limit fields may reach disk. The original command receives
the original stdin bytes; no model, network, login or credential APIs are used.
"""
import contextlib
import datetime
import fcntl
import json
import math
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile
import time

MAX_INPUT_BYTES = 128 * 1024
MAX_SETTINGS_BYTES = 1024 * 1024
SOURCE = "claude-code-statusline"


def iso_time(seconds=None):
    value = time.time() if seconds is None else seconds
    return datetime.datetime.fromtimestamp(value, datetime.timezone.utc).isoformat(
        timespec="milliseconds").replace("+00:00", "Z")


def default_root():
    return Path.home() / "Library/Application Support/ClaudeChanPet"


def private_directory(path, tighten=False):
    path = Path(path)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise ValueError("Expected a directory owned by the current user")
    if tighten:
        path.chmod(0o700)
    return path


def private_read(path, limit=MAX_SETTINGS_BYTES):
    """Read a regular, current-user-owned file without following its symlink."""
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(str(path), flags)
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            raise ValueError("Expected a regular file owned by the current user")
        data = handle.read(limit + 1)
    if len(data) > limit:
        raise ValueError("File exceeds the permitted size")
    return data


def read_json(path, limit=MAX_SETTINGS_BYTES):
    return json.loads(private_read(path, limit).decode("utf-8"))


def atomic_write(path, data):
    """Write only caller-approved bytes, mode 0600, then replace atomically."""
    path = Path(path)
    if path.is_symlink():
        raise ValueError("Refusing to replace a symlink")
    fd, temporary = tempfile.mkstemp(prefix="." + path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def atomic_json(path, value):
    atomic_write(path, (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8"))


@contextlib.contextmanager
def private_lock(path, timeout=0.25):
    fd = os.open(str(path), os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            raise ValueError("Invalid lock file")
        os.fchmod(fd, 0o600)
        deadline = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError("Local bridge lock is busy")
                time.sleep(0.01)
        yield
    finally:
        os.close(fd)


def finite_number(value):
    return type(value) in (int, float) and math.isfinite(value)


def reject_json_constant(_value):
    raise ValueError("Non-finite JSON constant")


def parse_windows(raw):
    """None means malformed; {} is a valid report with unavailable windows."""
    if len(raw) > MAX_INPUT_BYTES:
        return None
    try:
        value = json.loads(raw.decode("utf-8"), parse_constant=reject_json_constant)
        if not isinstance(value, dict):
            return None
        limits = value.get("rate_limits")
        if limits is None:
            return {}
        if not isinstance(limits, dict):
            return None
        windows = {}
        for key, name in (("five_hour", "fiveHour"), ("seven_day", "sevenDay")):
            bucket = limits.get(key)
            if bucket is None:
                continue
            if not isinstance(bucket, dict):
                return None
            used, reset = bucket.get("used_percentage"), bucket.get("resets_at")
            if not finite_number(used) or not 0 <= used <= 100:
                return None
            if not finite_number(reset) or reset < 0:
                return None
            windows[name] = {"usedPercent": used, "resetsAt": iso_time(reset)}
        return windows
    except (ValueError, UnicodeError, TypeError, OverflowError, OSError, RecursionError):
        return None


def record_quota(raw, root, received_ns=None):
    """False means rejected/unchanged; timestamps describe receipt, not a new API fetch.

    Capture received_ns BEFORE reading stdin. The private sequence watermark advances
    even for duplicate reports so an older, delayed process cannot overwrite them.
    """
    if received_ns is None:
        received_ns = time.time_ns()
    windows = parse_windows(raw)
    if windows is None:
        return False
    root = private_directory(root)
    usage = private_directory(root / "usage", tighten=True)
    with private_lock(usage / "quota.lock"):
        sequence_file = usage / "quota-sequence.json"
        try:
            previous_order = read_json(sequence_file).get("receivedNs", -1)
        except FileNotFoundError:
            previous_order = -1
        if not isinstance(previous_order, int) or received_ns <= previous_order:
            return False
        quota_file = root / "quota.json"
        try:
            previous = read_json(quota_file)
        except (FileNotFoundError, ValueError, UnicodeError):
            previous = None
        # Commit the watermark first: a crash must never allow an older writer in.
        atomic_json(sequence_file, {"receivedNs": received_ns})
        if isinstance(previous, dict) and previous.get("source") == SOURCE and previous.get("windows") == windows:
            return False
        atomic_json(quota_file, {"source": SOURCE, "updatedAt": iso_time(received_ns / 1e9), "windows": windows})
    return True


def original_command(root):
    try:
        original = read_json(Path(root) / "usage/original-statusline.json")
        if original.get("active") is False or not original.get("statusLineExisted"):
            return None
        statusline = original.get("statusLine")
        if isinstance(statusline, dict) and statusline.get("type") == "command":
            command = statusline.get("command")
            if isinstance(command, str) and command:
                return command
    except (OSError, ValueError, TypeError, UnicodeError):
        pass
    return None


def forward_original(command, prefix, remainder):
    """Stream oversize input too, without making a raw temporary file or log."""
    if command is None:
        while remainder.read(64 * 1024):
            pass
        return 0
    process = subprocess.Popen(["/bin/sh", "-c", command], stdin=subprocess.PIPE)
    try:
        process.stdin.write(prefix)
        while True:
            chunk = remainder.read(64 * 1024)
            if not chunk:
                break
            process.stdin.write(chunk)
        process.stdin.close()
    except BrokenPipeError:
        try:
            process.stdin.close()
        except BrokenPipeError:
            pass
    return process.wait()


def main():
    received_ns = time.time_ns()
    script_dir = Path(__file__).absolute().parent
    root = script_dir.parent if script_dir.name == "usage" else default_root()
    command = original_command(root)
    raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    try:
        record_quota(raw, root, received_ns)
    except (OSError, ValueError, TypeError, OverflowError, RecursionError):
        # The optional pet display must not change the original command's output.
        pass
    result = forward_original(command, raw, sys.stdin.buffer)
    if result < 0:
        signum = -result
        signal.signal(signum, signal.SIG_DFL)
        os.kill(os.getpid(), signum)
    return result


if __name__ == "__main__":
    sys.exit(main())
