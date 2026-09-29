#!/bin/sh

set -e

cd "$(dirname "$0")"

if [ -z "$1" ]; then
    echo "用法："
    echo "  ./restore.sh backups/scratch-data-YYYYMMDD-HHMMSS.tar.gz"
    exit 1
fi

BACKUP_FILE="$1"

if [ ! -f "$BACKUP_FILE" ]; then
    echo "找不到備份檔：$BACKUP_FILE"
    exit 1
fi

echo "即將還原：$BACKUP_FILE"
echo "目前 data/ 內容會被覆蓋。"

printf "輸入 RESTORE 確認："
read CONFIRM

if [ "$CONFIRM" != "RESTORE" ]; then
    echo "已取消。"
    exit 1
fi

docker compose down

SAFETY="./backups/pre-restore-$(date +%Y%m%d-%H%M%S).tar.gz"

mkdir -p backups

tar -czf "$SAFETY" \
  data/students.json \
  data/teachers.json \
  data/settings.json \
  data/uploads \
  data/deleted-classes \
  data/restored-classes

echo "已建立還原前安全備份：$SAFETY"

rm -rf \
  data/uploads \
  data/deleted-classes \
  data/restored-classes

tar -xzf "$BACKUP_FILE"

docker compose up -d

echo "還原完成。"
