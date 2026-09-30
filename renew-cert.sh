#!/bin/bash

set -e

cd "$(dirname "$0")"

if [ ! -d letsencrypt ]; then
    echo "找不到 letsencrypt/，目前可能尚未啟用 HTTPS"
    exit 1
fi

if [ ! -d certbot-www ]; then
    echo "找不到 certbot-www/"
    exit 1
fi

echo "開始檢查 Let's Encrypt 憑證續期..."

docker run --rm \
-v "$PWD/certbot-www:/var/www/certbot:Z" \
-v "$PWD/letsencrypt:/etc/letsencrypt:Z" \
certbot/certbot \
renew \
--webroot \
--webroot-path /var/www/certbot \
--quiet

echo "重新載入 Nginx..."

docker compose \
-f docker-compose.yml \
-f docker-compose.https.yml \
exec -T scratch-web \
nginx -s reload

echo "憑證續期檢查完成"
