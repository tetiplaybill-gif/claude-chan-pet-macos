#!/bin/zsh
# Explicitly restore/load only this project's existing user LaunchAgent.
set -eu
label="io.github.mushan08.claude-chan-pet.launcher"
agent="$HOME/Library/LaunchAgents/$label.plist"
if [[ -L "$agent" || -L "$agent.disabled" ]]; then
  print -u2 'Refusing a symlinked launcher entry.'
  exit 1
fi
restored_entry=0
if [[ -f "$agent.disabled" ]]; then
  if [[ -e "$agent" ]]; then
    print -u2 'Both active and disabled entries exist; inspect them first.'
    exit 1
  fi
  /bin/mv "$agent.disabled" "$agent"
  restored_entry=1
fi
if [[ ! -f "$agent" ]]; then
  print -u2 'No launcher entry found; run install-launcher.py explicitly first.'
  exit 1
fi
bootstrap_code=0
/bin/launchctl bootstrap "gui/$(/usr/bin/id -u)" "$agent" || bootstrap_code=$?
if (( bootstrap_code != 0 )); then
  if (( restored_entry == 1 )); then
    /bin/mv "$agent" "$agent.disabled"
  fi
  print -u2 'Activation was not confirmed. Inspect launchctl output; any disabled backup was restored.'
  exit "$bootstrap_code"
fi
print 'Claude pet startup enabled.'
