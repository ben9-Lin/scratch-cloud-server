# Changelog

## v1.0.0

第一個穩定基準版本。

### 學生端
- 學生帳號登入
- Scratch 線上編輯
- 雲端作品儲存
- 開啟、下載、刪除作品
- 同名作品覆蓋／另存新檔
- 顯示最近雲端儲存時間
- 修改作品後顯示未儲存提醒
- 學生自行修改密碼

### 教師端
- 教師／管理者登入
- 班級管理
- 學生帳號管理
- CSV 批次匯入
- 教師帳號管理
- 教師資料修改
- 班級啟用／停用／刪除
- 系統狀態
- 作品清單與 Excel 匯出

### 系統
- Docker Compose 部署
- Ubuntu 安裝腳本
- CentOS 8 安裝腳本
- backup / restore
- update / rollback
- bcrypt 密碼雜湊
- Session 登入機制

### 下一階段
- HTTPS
- Reverse Proxy
- Google Login
- SSO

## v1.1.0

HTTPS 與網路安全更新。

### 新增
- 正式網域 HTTPS
- Nginx Reverse Proxy
- Let's Encrypt 憑證
- IPv4 / IPv6 支援
- 自動憑證續期
- HTTP 自動轉 HTTPS

### 安全調整
- 前端 API 改走 `/api/`
- API 3000 port 僅保留於 Docker 內部 network
- 不再公開 3000/tcp
- 憑證與私鑰排除於 Git repository

### 後續規劃
- Google Login
- SSO
