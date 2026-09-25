#!/bin/bash
# Installs a macOS LaunchAgent that dumps Turso once a week (Sunday 10:00 local).
# Uses this machine's server/.env. The Mac must be on (or wake) around that time.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
if [[ -z "$NODE" ]]; then
  echo "node not found in PATH" >&2
  exit 1
fi
BACKUP_DIR="${BACKUP_DIR:-$HOME/Documents/BalletMind-backups}"
mkdir -p "$BACKUP_DIR"
LABEL="com.balletmind.weekly-backup"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE}</string>
    <string>${ROOT}/scripts/backup.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BACKUP_DIR</key>
    <string>${BACKUP_DIR}</string>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key>
    <integer>0</integer>
    <key>Hour</key>
    <integer>10</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${BACKUP_DIR}/backup.log</string>
  <key>StandardErrorPath</key>
  <string>${BACKUP_DIR}/backup.err</string>
</dict>
</plist>
EOF
UID_NUM="$(id -u)"
launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/${UID_NUM}" "$PLIST"
launchctl enable "gui/${UID_NUM}/${LABEL}"
echo "weekly backup: Sunday 10:00 → ${BACKUP_DIR}"
echo "loaded ${LABEL}"
