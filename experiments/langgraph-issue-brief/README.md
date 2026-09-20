# LangGraph 课前提醒（多 Agent）

练习项目：分析 → 写作 → 审核，审核失败打回写作。

**不是生产默认路径。** 现网 `GET /api/progress/brief` 对所有用户仍渲染规则课前卡（0 次 LLM）。

生产接线在 `server/ai/issue-brief-experiment.js`，闸门 `server/experiments/issue-brief-gate.js`：必须同时打开 `EXPERIMENT_ISSUE_BRIEF` 和 `EXPERIMENT_ISSUE_BRIEF_USER_IDS`，否则无人走实验。失败回退规则卡。
