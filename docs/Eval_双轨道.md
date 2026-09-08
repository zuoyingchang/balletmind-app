# BalletMind｜Offline Eval + 双轨道（停扩功能）

> V0.1 核心已够作品集。Agent / Fine-tuning / RAG / Ask My Training / 月度报告 **放到 V0.2+**，现在不实现。  
> 近期只做：Eval Set → Baseline → Model Selection → Bad Case / Prompt → Guardrails → 埋点 → 3–6 人试用。

面试和日常对照用这一份操作说明：[`docs/Metrics_Runbook.md`](Metrics_Runbook.md)（怎么跑、怎么看、每层现有指标）。

闭环：`Offline Eval → Deploy → Online Data → Bad Cases → Eval Set → Fix → Regression → Deploy`

---

## 为什么现在不加 Agent / RAG / Fine-tuning

| 问 | V0.1 回答 |
|---|---|
| 为什么没有 Agent？ | 核心是确定的 Capture → Structure → Review → Save，不需要模型动态决定下一步。Agent 会加 latency、cost 和失败面。Ask My Training 再评估。 |
| 为什么没有 Fine-tuning？ | 没有足够标注的「正确复盘」。先 Prompt + Eval + Model Selection。 |
| 为什么没有 RAG？ | 当前是**单次 session 抽取**，没有外部知识库检索。纵向洞察先用规则 + 用户确认；用户真需要再做 Ask My Training。 |

这三个「不做」是产品/技术取舍，写进 case study，不要为简历硬接 LangGraph。

---

## 两轨道

**Offline AI Track**（`cd server && npm run eval`，花真实 Anthropic 费用，不进 `npm test`）

1. 扩大黄金集（本仓库约 30+ 条，目标 30–50）  
2. Baseline（记下当前 `AI_MODEL` + `PROMPT_VERSION` 的 Layer 1 五维 + 本跑 latency/token）  
3. Model Selection：同一 Eval Set + Prompt + Schema，只改 `.env` 的 `AI_MODEL`  
4. Prompt 迭代：只根据 FAIL 的 Bad Case 改，改完升 `PROMPT_VERSION` 再跑  
5. Regression：同一批 case 重跑  
6. Hallucination / Guardrails 已写进 Prompt 与 case（老师加戏、信息不足、注入、伤病）

**Online Product Track**

埋点 → 3–6 个真人 → Completion / Edit / History / Progress → 线上 Bad Case 加回黄金集 → 再 Deploy。

---

## 三层指标（面试就用这张表）

| Layer | 要回答的问题 | BalletMind 现在看什么 |
|---|---|---|
| **AI / Model Quality** | AI 做得对不对？ | Offline `npm run eval`：Field Coverage、Classification、Hallucination-free **以及 Unsupported Content Rate（前者的失败率）**、Terminology、Schema。线上只有模型自报 confidence，**不能代替五维**。不用 Precision/Recall。 |
| **System / Production** | 稳不稳、贵不贵、快不快？ | Eval：本跑 latency / P95 / token / 估算 USD。线上 `stats.html`：AI/ASR 成功率、平均+**P95**、token、费用、retry、**失败原因分类**。 |
| **Product / User** | 用户有没有走完、会不会回来？ | **规范漏斗（session）**：Record started → Voice completed → ASR → AI → Review → Confirm。详见 [`Layer3_Event_Taxonomy.md`](Layer3_Event_Taxonomy.md)。禁止用无关 unique 相除。Activation / Completion / Edit / Regenerate / History Revisit / D7 已定义；旧数据不回填。 |

**Edit Rate ≠ AI Error Rate。** 用户可能只是改口吻。`user_edit_ai_result` 目前只有 `edited: true/false`，没有 edit reason；先别为了指标加一套理由问卷。

---

## Case 怎么写

每条：`transcript`（Input）→ `rubric`（Expected / 人工标准）→ `type` → `dimensions` → `check`。

类型覆盖：happy、insufficient、hallucination、terminology、asr_error（含格朗巴特芒 / 普利耶 / 皮鲁埃特）、injection、teacher_vs_self、mixed_language、safety、grouping、classification、missing_field、repetition、vague、empty。

失败时先按这条链归因：`ASR → terminology → Prompt → LLM → schema → backend/UI`（case 上的 `rootCauseHint` 是先验，不是自动根因）。

---

## Model Selection 怎么跑

```bash
cd server
# Baseline
npm run eval
# 只改一个变量
# .env: AI_MODEL=claude-... 另一个候选
npm run eval
```

比较：五维质量 × Schema 成功率 × 平均/P95 延迟 × 估算费用。选的是**最适合抽取任务**的，不是最聪明的聊天模型。

中文存档（2026-09-08 三模型实测）：[`docs/Eval_Model_Selection_Report.md`](Eval_Model_Selection_Report.md)。
