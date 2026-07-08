# FBA Tracker

亚马逊 FBA 选品 / 生产 / 上架全流程管理工具。局域网内多人协作，本地 SQLite 存储，数据自己掌控。

## 快速开始

```bash
npm install
pip3 install -r requirements.txt
npm run build           # esbuild 把 src/ 打包为 compiled/bundle.js
python3 -m backend.app  # 或 npm start（自动先构建再启动），默认 http://localhost:8002
```

首次启动会自动创建 `data/fba-users.json`，默认账号 `admin` / `fba2025`，**请尽快修改密码**。

## 文档导航

| 文档 | 内容 |
|---|---|
| [docs/business-overview.md](docs/business-overview.md) | 业务逻辑：FBA 18 阶段流程、SKU 变体与生产批次规则、工具模块定位 |
| [docs/operations.md](docs/operations.md) | 部署与协作操作手册：启动参数、登录、同步状态含义、备份、防火墙 |
| [CLAUDE.md](CLAUDE.md) | 技术架构：技术栈、目录结构、数据库/API、前端状态管理（给开发者/AI看） |
| [docs/plans/](docs/plans/) | 历史功能实施方案（归档） |
