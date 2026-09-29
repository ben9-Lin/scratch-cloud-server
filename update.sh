#!/bin/bash

set -e

cd "$(dirname "$0")"

UPDATE_FILE="$1"

if [ -z "$UPDATE_FILE" ]; then
    echo "用法："
    echo "  ./update.sh /root/scratch-update-YYYYMMDD.tar.gz"
    exit 1
fi

if [ ! -f "$UPDATE_FILE" ]; then
    echo "找不到更新檔：$UPDATE_FILE"
    exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)"

BACKUP_DIR="/root/scratch-update-backup-$STAMP"
TEMP_DIR="/root/scratch-update-temp-$STAMP"

echo "======================================"
echo " Scratch 雲端平台更新"
echo "======================================"
echo
echo "更新檔：$UPDATE_FILE"
echo
echo "注意："
echo "  不會覆蓋 data/"
echo "  不會修改學生帳號、教師帳號、作品"
echo

echo "[1/8] 建立更新前備份..."

mkdir -p "$BACKUP_DIR"

cp -a html \
"$BACKUP_DIR/"

cp -a api \
"$BACKUP_DIR/"

echo "備份完成：$BACKUP_DIR"

echo
echo "[2/8] 解壓更新包..."

mkdir -p "$TEMP_DIR"

tar -xzf \
"$UPDATE_FILE" \
-C "$TEMP_DIR"

if [ ! -d "$TEMP_DIR/html" ]; then
    echo "更新包缺少 html/"
    exit 1
fi

if [ ! -d "$TEMP_DIR/api" ]; then
    echo "更新包缺少 api/"
    exit 1
fi

echo
echo "[3/8] 更新學生／教師前端..."

[ -f "$TEMP_DIR/html/index.html" ] && \
cp "$TEMP_DIR/html/index.html" \
html/

[ -f "$TEMP_DIR/html/teacher.html" ] && \
cp "$TEMP_DIR/html/teacher.html" \
html/

[ -f "$TEMP_DIR/html/teacher-view.html" ] && \
cp "$TEMP_DIR/html/teacher-view.html" \
html/

echo
echo "[4/8] 更新 Scratch GUI..."

if [ -d "$TEMP_DIR/html/official" ]; then

    rm -rf html/official.new

    cp -a \
    "$TEMP_DIR/html/official" \
    html/official.new

    if [ -d html/official ]; then
        rm -rf html/official.previous
        mv html/official \
        html/official.previous
    fi

    mv html/official.new \
    html/official

    echo "Scratch GUI 已更新"

else
    echo "更新包沒有 official/，略過 Scratch GUI"
fi

echo
echo "[5/8] 更新 API 程式..."

[ -f "$TEMP_DIR/api/server.js" ] && \
cp "$TEMP_DIR/api/server.js" \
api/

[ -f "$TEMP_DIR/api/package.json" ] && \
cp "$TEMP_DIR/api/package.json" \
api/

[ -f "$TEMP_DIR/api/package-lock.json" ] && \
cp "$TEMP_DIR/api/package-lock.json" \
api/

echo
echo "檢查 API 必要套件..."

if ! grep -q '"exceljs"' api/package.json; then
    echo "錯誤：api/package.json 缺少 exceljs"
    echo "停止更新，避免 API 無法啟動"
    exit 1
fi

if ! grep -q '"exceljs"' api/package-lock.json; then
    echo "錯誤：api/package-lock.json 缺少 exceljs"
    echo "停止更新，避免 API 無法啟動"
    exit 1
fi

echo "exceljs：OK"

echo
echo "[6/8] 驗證設定..."

docker compose config >/dev/null

echo "docker-compose.yml OK"

echo
echo "[7/8] 重建 API..."

docker compose build \
--no-cache \
scratch-api

docker compose up -d \
--force-recreate \
scratch-api

docker compose restart \
scratch-web

echo
echo "[8/8] 驗證服務..."

sleep 5

docker compose ps

echo
echo "測試 API..."

if curl -fsS \
http://127.0.0.1:3000/settings \
>/dev/null
then
    echo
    echo "API：正常"
else
    echo
    echo "API 測試失敗"
    echo
    echo "請查看："
    echo "  docker compose logs --tail=100 scratch-api"
    echo
    echo "更新前備份位於："
    echo "  $BACKUP_DIR"
    exit 1
fi

rm -rf "$TEMP_DIR"

echo
echo "======================================"
echo " 更新完成"
echo "======================================"
echo
echo "備份："
echo "  $BACKUP_DIR"
echo
echo "請在瀏覽器使用 Ctrl + Shift + R"
echo
