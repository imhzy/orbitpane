# Project Operations & Development Rules

## 1. Backend Service Management (后台服务管理)
- **Tool**: 后台使用 `pm2` 管理运行。
- **Process Name**: `orbitpane-backend`
- **Requirement**: **每次修改** 后端代码（位于 `backend/` 目录下的文件，如 `main.py` 等）后，必须重启 pm2 服务。
- **Command**:
  ```bash
  pm2 restart orbitpane-backend
  ```
- **Verification**: 修改并重启后，执行 `pm2 status orbitpane-backend` 或检查日志 `pm2 logs orbitpane-backend --lines 20` 验证服务运行正常。

## 2. Frontend Build Requirement (前端构建规范)
- **Directory**: 前端位于 `frontend/` 目录。
- **Requirement**: **每次修改** 前端代码（位于 `frontend/src/` 或配置文件）后，必须执行构建命令。
- **Command**:
  ```bash
  cd /srv/orbitpane/frontend && npm run build
  ```
- **Verification**: 确保构建成功无 TypeScript 类型错误或打包报错，确保产物已成功更新至 `frontend/dist`。

## 3. Remote Sync & Execution for Non-Linux Environments (非 Linux 环境远程同步与执行规范)
- **Condition**: 如果当前开发环境不在 Linux 环境下（如 Windows 开发环境）。
- **Requirement**: 修改代码后，**必须**先将代码提交并 push 到远程仓库，然后通过 SSH 登录到 `hzycode-hk` 服务器的部署目录 `/srv/orbitpane` 下执行 `git pull` 以同步代码，最后再执行相应的服务启停或构建命令。
- **Command**:
  ```bash
  # 1. 本地提交并推送到远程
  git add .
  git commit -m "Update code"
  git push

  # 2. 通过 SSH 在 hzycode-hk 机器上拉取代码并重启/构建
  # 如果是后端修改:
  ssh hzycode-hk "cd /srv/orbitpane && git pull && pm2 restart orbitpane-backend"
  
  # 如果是前端修改:
  ssh hzycode-hk "cd /srv/orbitpane/frontend && git pull && npm run build"
  ```
