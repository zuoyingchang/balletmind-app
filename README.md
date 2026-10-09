# BalletMind

课后语音复盘：说几句 → Whisper 转写 → LLM 整理成草稿 → **你确认后才保存**。跨课次用规则看反复问题。追踪页可以查自己的档案（列出课记原文）。

线上：https://balletmind-app.onrender.com 。账号可在「我的」导出全部数据或注销删除。

产品文档（与现网对齐，2026-10-03）：`docs/pm_docs/` 下 Brief / PRD / Prompt / 补充材料 / User Flow。面试一页：`docs/Case_Study_BalletMind.md`。

## 项目结构

```
balletmind-app/
├── server/          Express + Turso + Whisper + LLM（Key 只在服务端）
├── public/          前端（index.html）
├── experiments/     LangGraph 对照；课前卡多 Agent 已接线但默认关
└── docs/            PRD / Eval / 案例
```

## 本地运行

```bash
cd server
npm install
cp .env.example .env   # 填 ANTHROPIC_API_KEY 或 DeepSeek 等、OPENAI_API_KEY、数据库
npm start              # http://localhost:3001
```

详见 `server/.env.example`。评测：`cd server && npm run eval`（抽取黄金集）；问问档案检索对照：`npm run eval:ask-retrieve`（加 `--live-embed` 才打 Embedding 列）。内部看板：`/stats.html`（需 `ADMIN_KEY`）。费用分列 DeepSeek / Anthropic / Whisper。查原始埋点：看板底部筛选，或 `GET /api/admin/events`。

数据库备份（含课记和密码哈希，不要提交）：`cd server && npm run backup`，文件默认写到 `~/Documents/BalletMind-backups`。本机每周日 10:00：`npm run backup:install-weekly`（电脑当时要开机）。Turso 免费档另有约 24 小时点回档。
