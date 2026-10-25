#!/bin/bash
# Launch one Codex agent per task brief. Usage: launch.sh 01 02 ...
CODEX=/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex
REPO=/Users/naveen/unlispace
mkdir -p /tmp/codex-runs
for n in "$@"; do
  f=$(ls $REPO/docs/agents/tasks/${n}-*.md)
  name=$(basename "$f" .md)
  "$CODEX" exec -m gpt-6.1-sol -s workspace-write --add-dir /tmp -C "$REPO" --skip-git-repo-check \
    "You are Codex agent '$name'. First read docs/agents/CODEX-RULES.md (binding), then your task brief $f. Complete the task exactly, writing only in the directories the brief names. End with a report: what you built, the exact gate command output summary lines, what you did not verify, and any NEEDS for other agents." \
    > /tmp/codex-runs/$name.log 2>&1 < /dev/null &
  echo "$name pid $!"
done
wait
