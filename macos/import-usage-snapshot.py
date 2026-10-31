#!/usr/bin/python3
"""Import percentages a user explicitly copied from the official Usage page.

No browser, UI, auth, network, model or Claude commands are accessed. Percentages
are USED amounts, not remaining amounts. Unknown reset instants remain null.
"""
import argparse
import datetime
import json
import math
from pathlib import Path
import re
import sys
import time
import unicodedata

from statusline_bridge import (atomic_json, default_root, iso_time,
                              private_directory, private_lock, read_json)

SOURCE = "claude-official-usage-page"
ZONED_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$")


def timestamp(value):
    if not isinstance(value, str) or not ZONED_ISO.fullmatch(value):
        raise ValueError("Sample time must be an ISO timestamp with Z or a timezone offset")
    try:
        date = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
        return date.timestamp()
    except (ValueError, OverflowError, OSError):
        raise ValueError("Sample time is not a valid timestamp") from None


def percentage(value):
    if type(value) not in (float, int) or not math.isfinite(value) or not 0 <= value <= 100:
        raise ValueError("Used percentages must be finite numbers from 0 to 100")
    return value


def reset_text(value):
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError("Reset text must be plain text")
    text = unicodedata.normalize("NFKC", value)
    if len(text) > 120 or any(unicodedata.category(char).startswith("C") or char in "<>" for char in text):
        raise ValueError("Reset text must be at most 120 characters, without markup or control characters")
    return text.strip()


def import_snapshot(output, five_hour=None, week=None, five_reset_text=None,
                    week_reset_text=None, sampled_at=None, now=None):
    now = time.time() if now is None else now
    if not math.isfinite(now):
        raise ValueError("Invalid local clock")
    if five_hour is None and week is None:
        raise ValueError("Provide at least one of --five-hour or --week")
    sampled = now if sampled_at is None else timestamp(sampled_at)
    if sampled > now:
        raise ValueError("Sample time cannot be in the future")
    windows = {}
    for name, used, label in (("fiveHour", five_hour, five_reset_text), ("sevenDay", week, week_reset_text)):
        if used is None:
            if label is not None:
                raise ValueError("Reset text requires its corresponding percentage")
            continue
        windows[name] = {"usedPercent": percentage(used), "resetsAt": None, "resetText": reset_text(label)}
    snapshot = {"source": SOURCE, "updatedAt": iso_time(sampled), "windows": windows}
    # Use the same precision as the written snapshot for ordering and idempotency.
    sampled = timestamp(snapshot["updatedAt"])
    output = Path(output).expanduser().absolute()
    if output.is_symlink() or output.parent.is_symlink():
        raise ValueError("Refusing a symlinked snapshot path")
    root = private_directory(output.parent)
    usage = private_directory(root / "usage", tighten=True)
    # Shared with the statusLine writer, so neither check races an atomic replace.
    with private_lock(usage / "quota.lock", timeout=5):
        try:
            previous = read_json(output, limit=64 * 1024)
        except FileNotFoundError:
            previous = None
        if previous is not None:
            if not isinstance(previous, dict):
                raise ValueError("Existing snapshot is invalid; refusing to replace it")
            try:
                previous_time = timestamp(previous.get("updatedAt"))
            except ValueError:
                raise ValueError("Existing snapshot time is invalid; refusing to replace it") from None
            if previous_time > sampled:
                raise ValueError("A newer snapshot already exists; nothing was replaced")
            if previous_time == sampled:
                if previous == snapshot:
                    return False
                raise ValueError("A different snapshot has the same sample time; nothing was replaced")
        sequence_file = usage / "quota-sequence.json"
        try:
            sequence = read_json(sequence_file, limit=4096)
            prior_order = sequence["receivedNs"]
            if type(prior_order) is not int:
                raise ValueError("Invalid bridge ordering metadata")
        except FileNotFoundError:
            prior_order = -1
        # Block any delayed bridge invocation older than this observed sample.
        atomic_json(sequence_file, {"receivedNs": max(prior_order, int(sampled * 1e9))})
        atomic_json(output, snapshot)
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--five-hour", type=float, help="current five-hour window USED percentage (0..100)")
    parser.add_argument("--week", type=float, help="weekly window USED percentage (0..100)")
    parser.add_argument("--five-reset-text", help="optional literal reset label, at most 120 characters")
    parser.add_argument("--week-reset-text", help="optional literal reset label, at most 120 characters")
    parser.add_argument("--sampled-at", help="known observation time in zoned ISO format; defaults to now")
    parser.add_argument("--output", type=Path, default=default_root() / "quota.json",
                        help="snapshot destination; use a temporary path for testing")
    args = parser.parse_args()
    try:
        imported = import_snapshot(args.output, args.five_hour, args.week, args.five_reset_text,
                                   args.week_reset_text, args.sampled_at)
    except (OSError, ValueError, TypeError, KeyError, OverflowError):
        # Never echo pasted text, quota values or existing account data to logs.
        print("Import refused: check percentages, plain reset labels, zoned sample time and destination. "
              "An equal/newer or unreadable existing sample is preserved.", file=sys.stderr)
        return 1
    print(json.dumps({"imported": imported, "source": SOURCE,
                      "windowCount": int(args.five_hour is not None) + int(args.week is not None)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
