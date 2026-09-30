#!/bin/bash

set -e

cd "$(dirname "$0")"

docker run --rm \
-v "$PWD/certbot-www:/var/www/certbot:Z" \
-v "$PWD/letsencrypt:/etc/letsencrypt:Z" \
certbot/certbot \
renew \
--webroot \
--webroot-path /var/www/certbot \
--quiet

docker compose exec -T scratch-web nginx -s reload
