# Project Operations & Development Rules

## 1. Backend Service Management (后台服务管理)
- **Tool**: 后台使用 `pm2` 管理运行。
- **Process Name**: `agy-backend`
- **Requirement**: **每次修改** 后端代码（位于 `backend/` 目录下的文件，如 `main.py` 等）后，必须重启 pm2 服务。
- **Command**:
  ```bash
  pm2 restart agy-backend
  ```
- **Verification**: 修改并重启后，执行 `pm2 status agy-backend` 或检查日志 `pm2 logs agy-backend --lines 20` 验证服务运行正常。

## 2. Frontend Build Requirement (前端构建规范)
- **Directory**: 前端位于 `frontend/` 目录。
- **Requirement**: **每次修改** 前端代码（位于 `frontend/src/` 或配置文件）后，必须执行构建命令。
- **Command**:
  ```bash
  cd /root/agy_web_bridge/frontend && npm run build
  ```
- **Verification**: 确保构建成功无 TypeScript 类型错误或打包报错，确保产物已成功更新至 `frontend/dist`。
