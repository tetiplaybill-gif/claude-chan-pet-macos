#!/bin/zsh
# Explicit, reversible action: unload only this launcher and retain its plist.
set -eu
label="io.github.mushan08.claude-chan-pet.launcher"
agent="$HOME/Library/LaunchAgents/$label.plist"
if [[ -L "$agent" || -L "$agent.disabled" ]]; then
  print -u2 'Refusing a symlinked launcher entry.'
  exit 1
fi
if [[ ! -f "$agent" ]]; then
  print 'Claude pet startup is disabled or not installed.'
  exit 0
fi
if [[ -e "$agent.disabled" ]]; then
  print -u2 'A .disabled backup already exists; inspect it before changing startup.'
  exit 1
fi
bootout_code=0
/bin/launchctl bootout "gui/$(/usr/bin/id -u)/$label" || bootout_code=$?
# ESRCH (3) means that this specific service was not loaded.
if (( bootout_code != 0 && bootout_code != 3 )); then
  print -u2 'Unable to confirm the launcher stopped; no files were renamed.'
  exit "$bootout_code"
fi
/bin/mv "$agent" "$agent.disabled"
print 'Claude pet startup disabled; app and local data retained.'
