#!/bin/bash

set -e

cd "$(dirname "$0")"

DOMAIN="$1"
EMAIL="$2"

if [ -z "$DOMAIN" ] || [ -z "$EMAIL" ]; then
    echo "用法："
    echo "  ./enable-https.sh <domain> <email>"
    echo
    echo "例如："
    echo "  ./enable-https.sh scratch.example.edu.tw admin@example.edu.tw"
    exit 1
fi

echo "======================================"
echo " Scratch Cloud HTTPS 啟用"
echo "======================================"
echo
echo "Domain: $DOMAIN"
echo "Email : $EMAIL"
echo

echo "[1/8] 檢查必要檔案..."

for f in \
    docker-compose.yml \
    docker-compose.https.yml \
    nginx/http.conf \
    nginx/https.conf.template
do
    if [ ! -f "$f" ]; then
        echo "缺少必要檔案：$f"
        exit 1
    fi
done

echo "必要檔案：OK"

echo
echo "[2/8] 檢查 DNS..."

if ! getent ahosts "$DOMAIN" >/dev/null 2>&1; then
    echo "無法解析網域：$DOMAIN"
    echo "請先確認 DNS 已指向此伺服器"
    exit 1
fi

getent ahosts "$DOMAIN" || true

echo
echo "[3/8] 建立憑證目錄..."

mkdir -p \
    certbot-www/.well-known/acme-challenge \
    letsencrypt

echo
echo "[4/8] 啟用 HTTP ACME 驗證設定..."

cp nginx/http.conf \
   nginx/default.conf

docker compose up -d \
    --force-recreate \
    scratch-web

echo
echo "測試 ACME 路徑..."

TEST_FILE="scratch-acme-$(date +%s)"

echo "$TEST_FILE" \
> certbot-www/.well-known/acme-challenge/test.txt

sleep 2

if ! curl -fsS \
    "http://$DOMAIN/.well-known/acme-challenge/test.txt" \
    | grep -q "$TEST_FILE"
then
    echo "ACME HTTP 驗證路徑無法從網域存取"
    echo
    echo "請確認："
    echo "  1. DNS 是否正確"
    echo "  2. TCP 80 是否對外開放"
    echo "  3. 上游防火牆是否允許 HTTP"
    exit 1
fi

rm -f \
certbot-www/.well-known/acme-challenge/test.txt

echo "ACME 路徑：OK"

echo
echo "[5/8] 申請 Let's Encrypt 憑證..."

docker run --rm \
    -v "$PWD/certbot-www:/var/www/certbot:Z" \
    -v "$PWD/letsencrypt:/etc/letsencrypt:Z" \
    certbot/certbot \
    certonly \
    --webroot \
    --webroot-path /var/www/certbot \
    --email "$EMAIL" \
    --agree-tos \
    --no-eff-email \
    -d "$DOMAIN"

CERT_DIR="letsencrypt/live/$DOMAIN"

if [ ! -f "$CERT_DIR/fullchain.pem" ] || \
   [ ! -f "$CERT_DIR/privkey.pem" ]; then
    echo "找不到申請完成的憑證"
    exit 1
fi

echo "憑證：OK"

echo
echo "[6/8] 產生 HTTPS Nginx 設定..."

sed \
    "s/__DOMAIN__/$DOMAIN/g" \
    nginx/https.conf.template \
    > nginx/default.conf

echo
echo "[7/8] 啟動 HTTPS..."

docker compose \
    -f docker-compose.yml \
    -f docker-compose.https.yml \
    config >/dev/null

docker compose \
    -f docker-compose.yml \
    -f docker-compose.https.yml \
    up -d \
    --force-recreate \
    scratch-web

sleep 3

echo
echo "測試 Nginx..."

docker compose \
    -f docker-compose.yml \
    -f docker-compose.https.yml \
    exec -T scratch-web \
    nginx -t

echo
echo "[8/8] 驗證 HTTPS..."

if ! curl -fsSI \
    "https://$DOMAIN" \
    >/dev/null
then
    echo "HTTPS 首頁測試失敗"
    exit 1
fi

if ! curl -fsS \
    "https://$DOMAIN/api/settings" \
    >/dev/null
then
    echo "HTTPS API 測試失敗"
    exit 1
fi

echo
echo "======================================"
echo " HTTPS 啟用完成"
echo "======================================"
echo
echo "網站："
echo "  https://$DOMAIN"
echo
echo "下一步建議："
echo "  ./renew-cert.sh"
echo
