# BalletMind V0.1｜模型选择报告（中文可存档版）

- **日期：** 2026-09-08  
- **条件：** 同一套 35 条 Offline Eval、Prompt v1.5、同一 schema / `submit_review` tool  
- **Layer 1–2：** 本次离线评测（真实 Anthropic 调用）  
- **Layer 3：** 生产库 events 全量快照（含自测；样本仍小）  
- **原始 JSON：** `server/eval/results/`（`claude-sonnet-4-6.json`、`claude-sonnet-5.json`、`claude-haiku-4-5-20251001.json`）

**结论（2026-09-08 对照 + 回归后）：生产切到 `claude-sonnet-5`。**  
请求体对 Sonnet 5 **不传 temperature**（传了会整批 400）。同一套 35 条、Prompt 1.5：质量与 4.6 打平（35/35），更便宜、略快。

**不换 Haiku：** 34/35，且本轮估算 $0.15 > Sonnet 5 的 $0.10，没有充分理由。

未跑 Opus / Fable：五维已经饱和，再上只会增加延迟和费用。

---

## 0. 核心决策对比表

| 指标 | Sonnet 4.6 | **Sonnet 5**（选定） | Haiku 4.5 |
|---|---|---|---|
| Eval 质量（35条通过率） | 35/35（100%） | **35/35（100%）** | 34/35（97.1%） |
| 平均延迟 | 3403 ms | **2454 ms** | 1848 ms |
| P95 延迟 | 4771 ms | **3513 ms** | 2548 ms |
| 35条估算成本 | $0.1705 | **$0.1047** | $0.1482（本轮cache未命中，实际更贵） |
| 单价（input/output，$/MTok） | $3 / $15 | **$2 / $10** | $1 / $5（本轮未吃到cache优势） |
| 接口兼容性 | 无需改动 | **需省略 `temperature` 参数**（否则整批400，已在代码里修复） | 无需改动 |
| 是否选用 | 否（对照 baseline） | ✅ **生产默认模型** | 否 |

### 为什么换成 Sonnet 5

1. **质量不降级**：同一套35条离线评测、同一Prompt v1.5，Sonnet 5 与 Sonnet 4.6 打平（100%通过），Field Coverage / Classification Accuracy / 幻觉 / 术语识别 / Schema Validity 五个维度没有一项掉分。这不是"降级换省钱"，是"同质量换更快更便宜"。
2. **延迟明显更低**：平均延迟降低约28%（3403ms → 2454ms），P95降低约26%（4771ms → 3513ms）。语音训练复盘是同步等待AI返回的交互，延迟直接影响体验。
3. **成本更低**：35条估算成本从$0.1705降到$0.1047，降幅约39%；单价（input/output）也都是Sonnet 4.6的三分之二。
4. **Haiku 不是更优解**：单价看着最低，但本轮cache未命中，121k input token按全价计费，实际总成本（$0.1482）反而高于用了cache的Sonnet 5；质量上还漏掉一个"含糊表述不该硬造具体动作名"的case——在"不编造用户没说过的内容"这条产品红线上，不如两个Sonnet可靠。
5. **代价是接口兼容性，不是模型能力**：Sonnet 5 请求体不能再传 `temperature`（传了会整批400 `invalid_request_error`），第一轮测试因此0/35。这是接口适配问题，已在 `server/ai/anthropic.js` 里按模型名跳过该字段，修复后质量与4.6打平——上线前必须先做这一步兼容，不能当成"模型变笨了"。

---

## 1. 测了哪三个模型

| 模型 | Layer 1 通过 | 平均 / P95 延迟 | 35 条估算费用 | 备注 |
|---|---|---|---|---|
| **claude-sonnet-4-6** | **35/35（100%）** | 3.4s / 4.8s | **$0.1705** | 对照 baseline；temperature=0.2 |
| **claude-sonnet-5**（现网默认） | **35/35（100%）** | 2.5s / 3.5s | **$0.1047** | 必须省略 `temperature` |
| **claude-haiku-4-5-20251001** | **34/35（97.1%）** | 1.8s / 2.5s | **$0.1482** | 唯一失败见下文；本轮 cache read = 0 |

单价（公开 list price，2026-09，美元 / 百万 token）：

| 模型 | Input | Output | Cache write | Cache hit |
|---|---|---|---|---|
| Sonnet 4.6 | $3 | $15 | $3.75 | $0.30 |
| Sonnet 5 | $2 | $10 | $2.50 | $0.20 |
| Haiku 4.5 | $1 | $5 | $1.25 | $0.10 |

费用是估算，以 Anthropic 控制台账单为准。

**Sonnet 5 不是 drop-in：** 第一轮 0/35，平均 224ms，全部 `invalid_request_error`：`` `temperature` is deprecated for this model. ``  
代码已对 `claude-sonnet-5` / `claude-opus-5` / `claude-fable-5` 省略该字段后再跑，质量与 4.6 打平。**现网改模型前，请求体必须先兼容。**

---

## 2. Layer 1｜AI 质量（离线 Eval）

要回答的问题：**模型有没有抽出用户说过的内容，有没有编造老师反馈或芭蕾术语？**

现在 **不算 Precision / Recall**（那是以后 RAG retrieval 的指标）。

一条 case 失败，会记到该 case 标注的**每一个**维度上。

| 维度 | 在问什么 | 高分意味着 | 常见误读 | 本轮结果 |
|---|---|---|---|---|
| **Field Coverage** | 说过的内容有没有进对的槽（优点 / 待改进 / 下次注意） | 该进的进了 | 「每个字段都填满」不是目标；信息不足就该留空 | 三模型 tagged case 均为 **12/12（100%）** |
| **Classification Accuracy** | 老师纠错 vs 自我感受 vs 下次课意图 | 字段分对 | 用户在 Review 里改口吻 ≠ 分类错误 | **12/12** |
| **Unsupported Content（幻觉）** | 有没有编老师原话、训练计划、诊断 | 没编 | note 里列出候选动作名却不标不确定，仍算失败 | Haiku **19/20（95%）**；两个 Sonnet **20/20** |
| **Terminology Accuracy** | 口误能否归一；含糊时不硬套术语 | 格朗巴特芒等能对上；说不清就不写死 pirouette | ASR 错在上游，但可恢复的转写模型仍应归一 | Haiku **10/11（90.9%）**；两个 Sonnet **11/11** |
| **Schema Validity** | 是否返回可解析的 `submit_review` | App 能读 | API 400 时 schema 也是 0；那是系统可靠性，不是「模型笨」 | 请求被接受时 **35/35** |

### 按 case 类型（通过数 / 总数）

| 类型 | Sonnet 4.6 | Sonnet 5 | Haiku 4.5 |
|---|---|---|---|
| asr_error | 5/5 | 5/5 | 5/5 |
| classification | 1/1 | 1/1 | 1/1 |
| empty | 1/1 | 1/1 | 1/1 |
| grouping | 2/2 | 2/2 | 2/2 |
| hallucination | 3/3 | 3/3 | 3/3 |
| happy | 4/4 | 4/4 | 4/4 |
| injection | 2/2 | 2/2 | 2/2 |
| insufficient | 3/3 | 3/3 | 3/3 |
| missing_field | 2/2 | 2/2 | 2/2 |
| mixed_language | 3/3 | 3/3 | 3/3 |
| repetition | 1/1 | 1/1 | 1/1 |
| safety | 2/2 | 2/2 | 2/2 |
| teacher_vs_self | 4/4 | 4/4 | 4/4 |
| vague | 2/2 | 2/2 | **1/2** |

格朗巴特芒 / 普利耶 / 皮鲁埃特 / tandoo / play yay：**三个模型都过。**

### 唯一正式 Bad Case（Haiku）

- **名称：** 说不清的转 — 不得硬套 pirouette  
- **类型：** vague（维度：terminology + hallucination）  
- **输入大意：** 「今天练了那个转圈的动作，具体叫什么我也不记得了，反正转的时候有点晕。」  
- **实际：** note 里出现 pirouette、chaîné、fouetté 等候选，且未用 rubric 接受的不确定表述。  
- **归因桶：** LLM（不是 ASR）。  
- **下一步：** 收紧 Prompt「用户没说的动作名不要列举」→ 升 `PROMPT_VERSION` → **同一 35 条重跑**。不要为此换更大模型。

**读 Layer 1 的方法：** 35/35 表示**这套黄金集**被打满，不等于产品已完美。集合偏容易或 Prompt 已对齐时都会顶格。下一轮应加更难的线上 bad case，而不是先上 Opus。

---

## 3. Layer 2｜系统（本次 Eval + 生产 AI/ASR）

要回答的问题：**稳不稳、快不快、贵不贵？适不适合这个抽取任务？**

Eval 延迟 = 仅 Anthropic 往返，**不含** Whisper、不含页面。

| 指标 | Sonnet 4.6 | Sonnet 5 | Haiku 4.5 |
|---|---|---|---|
| 平均延迟 | 3403 ms | 2454 ms | 1848 ms |
| P95 延迟 | 4771 ms | 3513 ms | 2548 ms |
| Input tokens | 16,596 | 9,111 | 121,701 |
| Output tokens | 5,855 | 6,240 | 5,306 |
| Cache write | 2,359 | 2,585 | 0 |
| Cache read | 80,206 | 87,890 | 0 |
| 估算 USD | $0.1705 | $0.1047 | $0.1482 |

Haiku 单价更低，但本轮 **cache 未命中**，121k input 按全价算，35 条总成本接近甚至高于用了 cache 的 Sonnet 4.6。降本不能只看 $/MTok。

### 生产（Turso `ai_process_success` 等，2026-09-08 快照）

| 指标 | 数值 | 怎么看 |
|---|---|---|
| AI 成功 / 失败事件 | 22 / **0** → 成功率 100% | 这是 **HTTP + schema 可用性**，不是 Eval 质量 |
| 带 token 的调用 | 19 次，平均延迟 **7230 ms** | 含线上真实路径，比 eval 纯模型调用更慢 |
| Input / Output tokens | 13,820 / 5,295 | 累计 |
| 估算费用 | **$0.1209**（约 **$0.0045 / 次保存**） | 按环境变量默认 $3/$15，不是账单 |
| ASR 成功 / 失败 | 27 / 5 → **84.4%** | 失败含权限 / Safari，**不能**直接当识别准确率 |
| ASR 平均延迟 | 2875 ms | 在 AI 之前 |
| Retry | 0 | 还看不出重试是否有用 |

**读 Layer 2 的方法：** 选模型看 **质量 × 可用性 × P95 × 真实账单形态（含 cache）**。Sonnet 5 第一轮 0 分是可靠性事故，不是质量分。

---

## 4. Layer 3｜产品漏斗（生产埋点）

要回答的问题：**用户有没有走完 Capture → Review → Save？归档有没有第二次被打开？**

次数含自测。优先看 **独立账号** 和近 7 天，不要只看总点击。  
**Edit Rate ≠ AI 错误率。** 目前只有 `edited: true/false`，没有「为什么改」。

### 总量

| 指标 | 数值 |
|---|---|
| 注册用户 | 22 |
| 至少保存过 1 条（激活） | 13 |
| 从未保存 | 9 |
| 激活率 | **59.1%** |
| 总记录 / 近 7 天记录 | 27 / 27 |
| 近 7 天有事件的账号 | 16 |
| 总事件数 | 275 |

### 漏斗（点击次数，全量）

| 事件 | 次数 | 独立用户 | 怎么看 |
|---|---|---|---|
| `record_voice_start` | 36 | 5 | 开始录音 |
| `record_voice_complete` | 29 | 5 | 36→29：权限、中断、放弃；**不是 AI 质量** |
| `asr_success` | 27 | 5 | 与 asr_fail 合成 ASR 成功率 |
| `asr_fail` | 5 | 2 | 见上 |
| `ai_process_success` | 22 | 8 | 生成成功 |
| `ai_process_fail` | （无记录） | — | 与成功率一起看 |
| `review_opened` | **0** | — | 代码已打点，**这条生产数据流里还没有**；部署前不能谈 Review 摩擦 |
| `user_edit_ai_result` | 27 | 13 | 与保存成对；**edited=true 为 0** |
| `save_record` | 27 | 13 | 正式记录（Review/Confirm 之后） |
| `history_open` | 65 | 5 | 归档被回看 |
| `progress_open` | 37 | **2** | 高度集中，还不能谈「进度页有价值」 |
| `retry_ai` | （无记录） | — | — |

保存 27 次 vs AI 成功 22 次（约 **0.8 次 AI / 次保存**）：存在**不走语音生成、直接保存**的路径。这会把「独立用户完成率」（13 保存 / 5 语音开始 = **260%**）撑爆——**不要用 unique save ÷ unique voice 当漏斗。** 用点击链路 + 以后的队列分析。

| 产品指标 | 现在 | 不要据此下的结论 |
|---|---|---|
| 记录完成率（保存/开始录音，点击） | 75%（27/36） | 分母含未完成录音 |
| Edit rate | **0%** | **不是幻觉率**；也可能是没人认真 Review |
| History 打开 | 65 次 / 5 人 | 还不是留存；留存要看第二周是否回来 |
| 激活用户人均记录 | 2.1 | 样本含作者自测 |

**Layer 3 目前回答不了的 PM 问题：** 下课会不会真的录、Review 烦不烦、AI 整理的是不是想存的、第二周回不回。需要 **3–6 个真人试用**，不是这次 Eval。

---

## 5. 决策与下一步

1. **生产默认 `claude-sonnet-5`**，请求不传 `temperature`。部署后看线上 latency / error / cost；Render 若写死了 `AI_MODEL=claude-sonnet-4-6` 需要改掉。  
2. **不换 Haiku**（质量与费用都没有优势）。  
3. **不要为简历换 Agent / Fine-tuning / RAG**；本任务是确定工作流上的抽取。  
4. 部署后才能读 `review_opened` 和带 `sessionId` 的漏斗。  
5. Eval 顶格之后，优先加更难的线上 bad case。  
6. 然后才是 3–6 人 User Test。

重跑：

```bash
cd server
AI_MODEL=claude-sonnet-4-6 npm run eval
# 只改模型，其他不变
AI_MODEL=claude-sonnet-5 npm run eval
AI_MODEL=claude-haiku-4-5-20251001 npm run eval
```

比较维度始终是：**质量 × 可靠性 × 延迟 × 成本**，不是「哪个模型最聪明」。
