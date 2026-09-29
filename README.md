# Scratch 雲端平台 Deployment V1

作者：阿鋒  
Email：ben@tykes.tn.edu.tw

## 系統需求

- Ubuntu 22.04 / 24.04
- Docker Engine
- Docker Compose Plugin
- 建議至少 2 GB RAM
- 建議使用固定 IP

## 啟動

```bash
cd scratch-cloud-deployment-v1
./start.sh

## CentOS 8 部署

CentOS 8 請使用：

```bash
sudo ./install-centos8.sh

## CentOS 8 實際部署驗證

Deployment V1 已完成 CentOS 8 實機部署測試。

CentOS 8 安裝時已處理：

- Podman / runc 與 Docker CE 套件衝突
- container-tools module 重設
- Docker CE 安裝
- Docker Compose Plugin
- SELinux bind mount `:Z`
- firewalld TCP 80
- firewalld TCP 3000
- API 所需 exceljs Node 套件

若 Web 頁面可以開啟，但教師登入顯示：

`Failed to fetch`

請先檢查：

```bash
docker compose ps
