# BalletMind 三层指标 Runbook

给以后的自己、给面试讲 case、给 3–6 人试用前对照。  
**不回填历史埋点。没有的数就是没有。**

---

## 0. 先记住三句话

| Layer | 问什么 | 怎么跑 | 去哪看 |
|---|---|---|---|
| **1 AI Quality** | 模型抽得对不对？ | `cd server && npm run eval` | 终端 + `server/eval/results/*.json` |
| **2 System** | 稳不稳、快不快、贵不贵？ | 部署后打开看板；eval 也会打本跑延迟/费用 | **线上** `/stats.html` 上半「Layer 2」 |
| **3 Product** | 用户有没有走完、会不会回来？ | 真人用产品，埋点自动进库 | **线上** `/stats.html` 下半「Layer 3」 |

- `npm test` **不跑** eval（不花钱、不打 Claude）。
- `/stats.html` **没有** Layer 1 五维。线上「AI 成功率」是 HTTP 通不通，不是抽取质量。
- 看数地址：`https://balletmind-app.onrender.com/stats.html`（要 `ADMIN_KEY`）。不要用浏览器直接打开本地 html 文件。

---

## 1. 这份 runbook 还写了什么

1. **怎么跑**：命令、环境变量、会不会花钱。  
2. **怎么看**：每个现有指标是干什么的、什么时候能下结论、常见误读。  
3. **何时跑**：改 Prompt / 换模型 / 上线后 / 真人测试前。  
4. **坏了怎么闭环**：归因链 → 改一处 → 回归 35 条 → 再部署。  
5. **明确没有的**：NPS、edit reason、RAG Precision/Recall、真人留存（D7 在样本极小时只是占位）。

---

## 2. Layer 1 · AI Quality（离线 Eval）

### 怎么跑

```bash
cd server
# 需要 .env 里的 ANTHROPIC_API_KEY；会打真实 Claude，花钱
npm run eval
```

默认模型看 `AI_MODEL`（代码默认 `claude-sonnet-5`）。只换模型、其他不动：

```bash
AI_MODEL=claude-sonnet-5 npm run eval
AI_MODEL=claude-sonnet-4-6 npm run eval   # 对照
```

- Prompt 版本：`PROMPT_VERSION`（当前 1.5），在 `server/ai/review-prompt.js`。  
- Case：约 35 条，`server/eval/cases.js`。  
- 结果 JSON：`server/eval/results/<model>.json`。  
- Sonnet 5 **请求里不传 temperature**；终端若写 `temperature=omitted` 是正常的。

改 Prompt 或改 schema 之后：**必须再跑一遍**，当作 regression，不要凭感觉。

### 怎么看

先看 **Overall case pass** 和 **FAIL 列表**，再看五维。  
一条 FAIL 会记到它标注的每一个维度上。失败时按这条链想原因：

`ASR → terminology → Prompt → LLM → schema → backend/UI`

Eval **没有 ASR**（输入已经是 transcript）。ASR 口误 case 测的是「转写已经错了，模型会不会归一」。

**现在不算 Precision/Recall**（那是以后 RAG 检索的）。

### 现有指标

| 指标 | 干什么 | 高分意味着 | 不要当成 |
|---|---|---|---|
| **Field Coverage** | 用户说过的内容有没有进对的槽（优点 / 待改进 / 下次） | 该进的进了 | 「每个字段都填满」。信息不足就该留空 |
| **Classification Accuracy** | 老师纠错 vs 自我感受 vs 下次课意图有没有分对 | 字段分对 | 用户在 Review 里改口吻 |
| **Hallucination-free** | 有没有编老师原话、计划、诊断、术语清单 | 没编 | 文笔好不好 |
| **Unsupported Content Rate** | 上一行的失败率 | 越低越好 | 和 Hallucination-free 是一对，不是新维度 |
| **Terminology Accuracy** | 口误/中英法能否对上；说不清时不硬套 pirouette | 术语对或诚实地不确定 | ASR 本身准不准（那是 Layer 2） |
| **Schema Validity** | 是否返回能解析的 `submit_review` | App 能读 | 内容正确。400 时这一维也会是 0 |
| **Overall case pass** | 35 条里几条整条过 | 黄金集被打满 | 产品已完美。集合偏易或 Prompt 已对齐都会顶格 |
| **by case type** | happy / asr_error / hallucination / injection… | 哪类场景在掉 | 样本量很小，一类 1–5 条 |

Eval 顺带打的 **本跑 Layer 2**（只代表这 35 次 Anthropic 调用，不含 Whisper、不含页面）：

| 指标 | 干什么 |
|---|---|
| avg / **P95 latency** | 这套抽取有多慢 |
| input / output / cache tokens | 贵不贵、cache 有没有打上 |
| estUsd | 这一跑大概多少钱（list price 估算） |

对照纪要：`docs/Eval_Model_Selection_Report.md`。

---

## 3. Layer 2 · System（生产看板 + eval 本跑）

### 怎么跑 / 怎么打开

1. 代码已部署到 Render（改了 `public/stats.html` 或 `server/` 才算进去）。  
2. 浏览器打开：`https://balletmind-app.onrender.com/stats.html`  
3. 输入 `ADMIN_KEY`。  
4. 看页面上半 **Layer 2 · System**。

免费实例睡着时先等 20–40 秒再刷新。

### 怎么看

问的是 **API 通不通、尾部慢不慢、钱烧多少**。  
AI 成功率 100% **不能** 推出「抽取没幻觉」。那要回 Layer 1。

P95 比平均值重要：平均值好看、P95 8 秒，真人会觉得卡。

### 现有指标

| 指标 | 干什么 | 不要当成 |
|---|---|---|
| **AI 调用成功率** | `ai_process_success / (success+fail)`，HTTP+schema 成没成 | Layer 1 质量 |
| **ASR 成功率** | Whisper 成功 / (成功+失败) | 术语识别准确率。失败含麦克风权限 |
| **Retry 占比** | 用户点 Retry 的比例 | 一定是模型错了（也可能超时） |
| **每条保存对应几次 AI 成功** | 生成次数 / 保存次数 | 用户很勤快。也可能没生成就保存（手打） |
| **失败原因** | timeout / api_error / quota / no_tool_use… | 没有行 = 还没失败，不是「永远不会失败」 |
| **AI 平均 / P95** | 整理接口耗时 | Eval 里的 2.5s（纯模型）。线上通常更慢 |
| **ASR 平均 / P95** | 语音识别耗时 | |
| **Token 输入/输出** | 用量 | 账单以 Anthropic 控制台为准 |
| **估算 LLM 费用 / 每次保存费用** | 按环境变量单价粗算 | 正式账单 |
| **模型自报 confidence** | 高/中/低次数 | **不是 Layer 1**，模型自己打分 |

---

## 4. Layer 3 · Product（生产看板）

### 怎么跑

没有单独命令。用户用产品，事件进 Turso。  
看 `/stats.html` 下半 **Layer 3 · Product**。

真人测试前建议在 Render 配：

```
ANALYTICS_INTERNAL_EMAILS=你的邮箱
```

看板会多一块「排除内部账号」。**不配就全体含自测。** 不会改旧事件。

部署 **带 sessionId 的版本之后**，规范漏斗才开始有数。更早的录音 **不会出现在 session 表里**。

### 怎么看

规范漏斗（conversion 只认同一 `sessionId`）：

**开始录音 → 录完 → ASR 成功 → AI 成功 → 打开 Review → 确认保存**

每步「相对上一步」= 走到这步的 session / 走到上一步的 session。

**禁止**用「保存过的独立账号 ÷ 开过录音的独立账号」。那会得到 260% 那种假完成率。

Edit / Retry / History **不是**漏斗步骤，是侧指标。

事件名对照：`docs/Layer3_Event_Taxonomy.md`。

### 现有指标

| 指标 | 干什么 | 不要当成 |
|---|---|---|
| **注册 / 激活 / 从未保存** | 漏斗最外圈：有没有人留下一条正式记录 | 留存 |
| **Activation** | 至少保存 1 条的用户 / 注册用户 | 「喜欢这个产品」 |
| **近 7 天保存 / 活跃** | 这周有没有人在用 | 日历周 cohort（不是） |
| **Completion（session）** | 语音 session 里走到确认保存的比例 | 点击总量、unique 相除 |
| **漏斗各步 Capture 数** | 卡在录音、ASR、Review 还是保存 | 把 History 算进同一次课 |
| **Edit Rate** | 确认保存时改过字段的 session 比例 | **AI 错误率**。改口吻也算 |
| **改过的字段 优点/改进/下次** | 人最常改哪一块 | 改了什么内容（我们不存文本） |
| **Regenerate Rate** | AI 成功后又点 Retry 的 session 比例 | 全部是幻觉。也可能超时 |
| **History Revisit** | 首次保存之后还打开过档案/某条记录 | 第二周还回来上课 |
| **D7 Retention** | 首次保存满 7 天之后还有任意事件 | 样本 &lt; 十人时不要当结论 |
| **保存 ≥2 条 / ≥2 个自然日** | 会不会记第二次 | 习惯养成 |
| **打开 Progress 次数** | 进度页有没有人看 | 页有价值（可能只有你自己点） |
| **附录：事件次数** | 调试埋点有没有打上 | conversion |

`field_edited` **只记字段名**，不记用户写了什么。

---

## 5. 什么时候跑哪一层

| 场景 | Layer 1 eval | Layer 2/3 看板 |
|---|---|---|
| 改 Prompt / schema / 温度逻辑 | **必跑** 35 条 | 部署后再看错误是否下降 |
| 换 `AI_MODEL` | **必跑** 同一套 case | 看线上 P95、费用、失败原因 |
| 只改 UI 文案、漏斗展示 | 不必 | 部署后确认看板 |
| 上线后日常 | 不需要天天跑（花钱） | 偶尔打开 `/stats.html` |
| 3–6 人试用期间 | 试用中的 bad case 加进黄金集后再 eval | **每天看 Layer 3**，含自测要心里有数 |
| 线上抽到幻觉/术语错 | 写成一条 case，修 Prompt，升版本，再 eval | 确认不是 ASR/超时 |

一次只改一个变量：模型 **或** Prompt，不要同一天两个都大改。

---

## 6. 坏了怎么闭环（Bad case）

1. 先判断落在哪一层：ASR 失败 → L2；抽错但 schema 对 → L1；没人点保存 → L3。  
2. L1：把 transcript + 期望写进 `cases.js`，修 Prompt，升 `PROMPT_VERSION`，`npm run eval`。  
3. L2：看失败原因和 P95，再决定超时、重试、换模型。  
4. L3：看漏斗卡在哪一步，再决定是不是 Review 太烦、录音权限、没有 History 价值。  
5. **不要**为了看板好看去补历史 `review_opened`。

---

## 7. 常见坑

- Eval 35/35 ≠ 真人觉得有用。  
- 线上 AI 成功率 100% ≠ 没幻觉。  
- Edit Rate 高 ≠ 模型差。  
- Session 漏斗全是 `-` 或 0：多半是 **新埋点还没部署**，或全是部署前的旧事件。  
- Render 只改了 `public/` 有时不会自动部署（Root Directory 是 `server/`）。看板旧了就手动 Deploy。  
- 控制台若写死 `AI_MODEL=claude-sonnet-4-6`，代码里的 Sonnet 5 默认不会生效。

---

## 8. 现在没有、runbook 也不装有的

- NPS、问卷、edit reason  
- RAG Precision/Recall  
- 按自然周的严格 cohort（只有「首次保存 +7 天」）  
- 线上自动 Layer 1 五维（没有 LLM-as-judge）  
- Agent / Fine-tuning / Ask My Training 相关指标  

这些等真人试用或以后的产品再加。
