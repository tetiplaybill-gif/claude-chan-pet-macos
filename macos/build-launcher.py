#!/usr/bin/env python3
"""Compile the local launcher into build/ without installing or enabling it."""
import argparse
import subprocess
import sys
from build_support import build_launcher


def main():
    argparse.ArgumentParser(description=__doc__).parse_args()
    try:
        print(build_launcher())
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print("Launcher build stopped: " + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
