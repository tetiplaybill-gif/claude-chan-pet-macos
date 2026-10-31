#!/usr/bin/env python3
"""Check tracked publication files without printing potentially sensitive content.

SPDX-License-Identifier: MIT
This is a focused guard, not a guarantee that every possible secret is detected.
It examines only this repository's tracked files and optional reachable history.
"""
from pathlib import Path
import argparse
import json
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
PATTERNS = {
    'personal-home-path': re.compile(rb'/(?:Users|home)/[A-Za-z0-9_.-]+/'),
    'windows-user-path': re.compile(rb'[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/]', re.I),
    'private-key': re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----'),
    'provider-secret': re.compile(rb'(?:gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:ant-)?[A-Za-z0-9_-]{30,})'),
    'credential-in-url': re.compile(rb'https?://[^\s/:]+:[^\s/@]+@'),
}
FORBIDDEN_DIRS = {'.claude', '.codex', 'node_modules', 'build', 'qa', 'out', 'runtime', 'downloads', '__pycache__'}
FORBIDDEN_NAMES = {'HANDOFF.md', 'MACOS_PLAN.md', 'LOCAL_MACOS.md', 'quota.json', 'settings.json', 'config.json', 'state.json', 'original-statusline.json', 'bridge-status.json', '.env'}
FORBIDDEN_SUFFIXES = {'.png', '.webp', '.webm', '.ico', '.dmg', '.zip', '.pkg', '.pyc', '.log', '.bak', '.pem', '.key'}


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--history', action='store_true', help='Also scan every reachable commit tree')
    args=parser.parse_args()
    tracked=[p.decode('utf-8') for p in git('ls-files','-z').split(b'\0') if p]
    if not tracked:
        raise SystemExit('No tracked files; stage the publication allowlist first.')
    findings=[]
    for name in tracked:
        path=Path(name)
        if path.is_absolute() or any(part in FORBIDDEN_DIRS or part.endswith('.app') for part in path.parts) or path.name in FORBIDDEN_NAMES or path.suffix.lower() in FORBIDDEN_SUFFIXES:
            findings.append({'file':name,'rule':'excluded-file-category'})
        full=ROOT/path
        if full.is_symlink(): findings.append({'file':name,'rule':'symlink'})
        content=full.read_bytes()
        if b'\0' in content: findings.append({'file':name,'rule':'binary-content'})
        for rule,pattern in PATTERNS.items():
            if pattern.search(content): findings.append({'file':name,'rule':rule})
    history_blobs=0
    if args.history:
        seen=set()
        for commit in git('rev-list','--all').splitlines():
            for line in git('ls-tree','-r',commit.decode()).splitlines():
                metadata,_,name=line.partition(b'\t')
                mode,kind,blob=metadata.split()
                if kind!=b'blob' or blob in seen: continue
                seen.add(blob); history_blobs+=1
                content=git('cat-file','blob',blob.decode())
                for rule,pattern in PATTERNS.items():
                    if pattern.search(content): findings.append({'historyBlob':blob.decode(),'rule':rule})
    print(json.dumps({'files':len(tracked),'historyBlobs':history_blobs,'findings':findings},ensure_ascii=False,indent=2))
    return bool(findings)


if __name__=='__main__': sys.exit(main())
