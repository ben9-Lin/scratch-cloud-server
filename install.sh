#!/bin/bash

set -e

cd "$(dirname "$0")"

echo "======================================"
echo " Scratch 雲端平台 Deployment V1"
echo " 安裝程式"
echo "======================================"
echo

if [ "$(id -u)" -ne 0 ]; then
    echo "請使用 root 或 sudo 執行："
    echo "  sudo ./install.sh"
    exit 1
fi

echo "[1/5] 檢查作業系統..."

if [ -f /etc/os-release ]; then
    . /etc/os-release
    echo "偵測到：$PRETTY_NAME"
else
    echo "無法判斷作業系統。"
    exit 1
fi

echo
echo "[2/5] 檢查 Docker..."

if command -v docker >/dev/null 2>&1; then
    echo "Docker 已安裝："
    docker --version
else
    echo "尚未安裝 Docker，開始安裝..."

    apt-get update

    apt-get install -y \
        ca-certificates \
        curl \
        gnupg

    install -m 0755 -d \
        /etc/apt/keyrings

    curl -fsSL \
        https://download.docker.com/linux/ubuntu/gpg \
        -o /etc/apt/keyrings/docker.asc

    chmod a+r \
        /etc/apt/keyrings/docker.asc

    . /etc/os-release

    echo \
        "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" \
        > /etc/apt/sources.list.d/docker.list

    apt-get update

    apt-get install -y \
        docker-ce \
        docker-ce-cli \
        containerd.io \
        docker-buildx-plugin \
        docker-compose-plugin

    echo "Docker 安裝完成。"
fi

echo
echo "[3/5] 檢查 Docker Compose..."

if docker compose version >/dev/null 2>&1; then
    docker compose version
else
    echo "Docker Compose Plugin 不可用。"
    exit 1
fi

echo
echo "[4/5] 啟用 Docker 服務..."

systemctl enable docker
systemctl start docker

echo
echo "[5/5] 啟動 Scratch 雲端平台..."

chmod +x \
    start.sh \
    stop.sh \
    backup.sh \
    restore.sh

./start.sh

echo
echo "======================================"
echo " Scratch 雲端平台安裝完成"
echo "======================================"

SERVER_IP=$(
    hostname -I \
    | awk '{print $1}'
)

echo
echo "學生端："
echo "  http://${SERVER_IP}/"

echo
echo "教師端："
echo "  http://${SERVER_IP}/teacher.html"

echo
echo "API："
echo "  http://${SERVER_IP}:3000/"

echo
echo "請務必登入後修改正式密碼。"
