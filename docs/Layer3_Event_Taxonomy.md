# BalletMind Layer 3｜事件 taxonomy 与漏斗定义

不回填历史事件。`review_opened` 在旧生产数据里是 0，部署之后才开始有。

## 规范漏斗（conversion 只按同一 `sessionId`）

**Record started → Voice completed → ASR success → AI success → Review opened → Session confirmed**

- 分母/分子都是**同一次 Capture**（`metadata.sessionId`）。
- **禁止**用「开过录音的独立账号」去除「保存过的独立账号」（会得到 260% 那种假完成率）。
- 没有 `sessionId` 的旧事件：**不计入 session conversion**，也不补写。
- 手动输入、没走录音的保存，不算进这条语音漏斗（单独记 typed session）。

Edit / Regenerate / History **不是**漏斗步骤，是侧指标。

## 事件名

| 产品名 | 库里的名字 | 说明 |
|---|---|---|
| record_started | `record_voice_start` | 开始录音；挂 capture `sessionId` |
| voice_completed | `record_voice_complete` | 录完一段并出字 |
| asr_success / asr_fail | 同名 | 服务端；header `X-Capture-Session` |
| ai_success / ai_fail | `ai_process_success` / `ai_process_fail` | 服务端；body `sessionId` |
| review_opened | `review_opened` | 进入 Review。旧数据没有就没有 |
| field_edited | `field_edited` | **只记 `field_name`**（good_points / improve_points / next_time_reminder / session_tips），**永不记用户文本** |
| ai_regenerated | `ai_regenerated`（旧 `retry_ai` 仍可读） | 用户点 Retry |
| session_confirmed | `session_confirmed` + 仍写 `save_record` | Review 后确认保存。activation 仍以 `save_record` 计，避免双计用户 |
| history_opened | `history_opened`（旧 `history_open`） | 打开档案列表；用 **browse** session，不挂 capture |
| history_session_opened | `history_session_opened` | 打开某一条过去记录；metadata 只有 `recordId` |
| progress_opened | `progress_opened`（旧 `progress_open`） | 打开 Progress |
| ask_success / ask_fail | 同名 | 问问档案。metadata 可有 `rounds`、`latencyMs`、`answered`、`matchCount`、`retrievalPath`、`keywordCount`、`embeddingCount`、token；**不记问题正文** |
| experiment_issue_brief_success / fail | 同名 | 课前卡多 Agent 实验。默认无流量（双开关关）。metadata 可有 `attempts`、`latencyMs`、`reason`；**不记生成正文** |

每条都有 `user_id` + `created_at`。Capture 链路带 `sessionId`；History/Progress 用另一条 browse session。

**metadata 白名单（永不记转写/复盘/邮箱）**：`sessionId`、`recordId`、`field_name`、`edited` / `editedFields`、`from`（voice|typed|mixed）、`slotsFilled`（0–4）、`durationSec`、`chars` / `bytes`、`error` / `reason` / `status`、`latencyMs`、`attempt`、token、`model`、`promptVersion`、`confidence_level`、`rounds` / `round`、`matchCount`、`answered`。

查原始行：`/stats.html` 底部筛选，或 `GET /api/admin/events?event=&limit=` + `X-Admin-Key`。

## 指标定义

| 指标 | 定义 |
|---|---|
| Activation | 至少 1 次 `save_record` 的用户 / 注册用户 |
| Completion Rate | 语音 Capture 中走到 session_confirmed 的 session / 有 record_started 的 session |
| Edit Rate | 带 `field_edited` 的已确认 session / 已确认 session |
| Regenerate Rate | 有 `ai_regenerated` 的语音 session / 有 AI success 的语音 session |
| History Revisit | 首次保存当时或之后打开过 History 或某条记录的激活用户 / 激活用户 |
| D7 Retention | 首次保存满 7 天后还有任意事件 / 已满 7 天的激活用户 |

Edit Rate ≠ AI 错误率。

## 自测 vs 真人

设置 `ANALYTICS_INTERNAL_EMAILS`（逗号分隔）后，看板会多一个 **excludingInternal** 切片。不改旧事件、不猜测谁是内部账号。
