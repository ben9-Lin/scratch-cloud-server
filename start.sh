#!/bin/sh

set -e

cd "$(dirname "$0")"

echo "=== Scratch 雲端平台啟動 ==="

docker compose up -d --build

echo
docker compose ps

echo
echo "完成。"
echo "學生端：http://伺服器IP/"
echo "教師端：http://伺服器IP/teacher.html"
