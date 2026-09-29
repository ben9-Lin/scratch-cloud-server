#!/bin/sh

set -e

cd "$(dirname "$0")"

docker compose down

echo "Scratch 雲端平台已停止。"
