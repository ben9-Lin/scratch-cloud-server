#!/bin/sh

set -e

cd "$(dirname "$0")"

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="./backups"
OUT="$BACKUP_DIR/scratch-data-$STAMP.tar.gz"

mkdir -p "$BACKUP_DIR"

tar -czf "$OUT" \
  data/students.json \
  data/teachers.json \
  data/settings.json \
  data/uploads \
  data/deleted-classes \
  data/restored-classes

echo "備份完成：$OUT"
