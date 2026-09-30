#!/bin/bash

set -e

cd "$(dirname "$0")"

echo "======================================"
echo " Scratch Cloud HTTPS 停用"
echo "======================================"
echo
echo "這個動作會："
echo "  1. 切回 HTTP Nginx 設定"
echo "  2. 停止 443 對外服務"
echo "  3. 保留 Let's Encrypt 憑證"
echo "  4. 不修改學生、教師、作品資料"
echo

if [ ! -f nginx/http.conf ]; then
    echo "找不到 nginx/http.conf"
    exit 1
fi

echo "[1/5] 備份目前 Nginx 設定..."

STAMP="$(date +%Y%m%d-%H%M%S)"

cp nginx/default.conf \
"nginx/default.conf.before-disable-https-$STAMP"

echo
echo "[2/5] 切回 HTTP 設定..."

cp nginx/http.conf \
nginx/default.conf

echo
echo "[3/5] 停止目前 Web container..."

docker compose \
    -f docker-compose.yml \
    -f docker-compose.https.yml \
    stop scratch-web 2>/dev/null || true

docker compose \
    -f docker-compose.yml \
    -f docker-compose.https.yml \
    rm -f scratch-web 2>/dev/null || true

echo
echo "[4/5] 以 HTTP 模式重新啟動..."

docker compose up -d \
    --force-recreate \
    scratch-web

sleep 3

docker compose exec -T \
scratch-web \
nginx -t

echo
echo "[5/5] 驗證 HTTP..."

if curl -fsS \
    http://127.0.0.1/api/settings \
    >/dev/null
then
    echo "HTTP API：正常"
else
    echo "HTTP API 測試失敗"
    echo
    echo "請查看："
    echo "  docker compose logs --tail=100 scratch-web"
    exit 1
fi

echo
echo "======================================"
echo " 已切回 HTTP"
echo "======================================"
echo
echo "Let's Encrypt 憑證仍保留在："
echo "  ./letsencrypt/"
echo
echo "若之後要重新啟用 HTTPS，可再次執行："
echo "  ./enable-https.sh <domain> <email>"
echo
