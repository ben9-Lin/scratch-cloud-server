#!/bin/bash

set -e

cd "$(dirname "$0")"

echo "======================================"
echo " Scratch 雲端平台 Deployment V1"
echo " CentOS 8 安裝程式"
echo "======================================"
echo

if [ "$(id -u)" -ne 0 ]; then
    echo "請使用 root 或 sudo 執行："
    echo "  sudo ./install-centos8.sh"
    exit 1
fi

echo "[1/6] 檢查作業系統..."

if [ -f /etc/os-release ]; then
    . /etc/os-release
    echo "偵測到：$PRETTY_NAME"
else
    echo "無法判斷作業系統。"
    exit 1
fi

echo
echo "[2/6] 檢查 Docker..."

if command -v docker >/dev/null 2>&1; then
    echo "Docker 已安裝："
    docker --version
else
    echo "尚未安裝 Docker，開始安裝..."

    echo "移除可能與 Docker 衝突的 container tools..."

    dnf remove -y \
        podman \
        podman-catatonit \
        buildah \
        runc \
        2>/dev/null || true

    dnf module reset -y container-tools || true

    dnf install -y \
        dnf-plugins-core \
        ca-certificates \
        curl

    dnf config-manager \
        --add-repo \
        https://download.docker.com/linux/centos/docker-ce.repo

    dnf install -y \
        docker-ce \
        docker-ce-cli \
        containerd.io \
        docker-buildx-plugin \
        docker-compose-plugin

    echo "Docker 安裝完成。"
fi

echo
echo "[3/6] 啟用 Docker..."

systemctl enable --now docker

echo
echo "[4/6] 檢查 Docker Compose..."

if docker compose version >/dev/null 2>&1; then
    docker compose version
else
    echo "Docker Compose Plugin 不可用。"
    exit 1
fi

echo
echo "[5/6] 設定防火牆..."

if systemctl is-active --quiet firewalld; then

    firewall-cmd \
        --permanent \
        --add-service=http

    firewall-cmd \
        --permanent \
        --add-port=3000/tcp

    firewall-cmd --reload

    echo "已開放 TCP 80 與 3000。"
else
    echo "firewalld 未啟用，略過。"
fi

echo
echo "[6/6] 啟動 Scratch 雲端平台..."

chmod +x \
    start.sh \
    stop.sh \
    backup.sh \
    restore.sh

./start.sh

SERVER_IP=$(
    hostname -I \
    | awk '{print $1}'
)

echo
echo "======================================"
echo " Scratch 雲端平台安裝完成"
echo "======================================"

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
echo "請登入後立即修改正式密碼。"
