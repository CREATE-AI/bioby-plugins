# CRM Ops Review：邮件提报待审

- **状态：** P0 写回已落地（四决策 + CRM scene；不再 `approve` → `IN_PROGRESS`）
- **驱动：** `crm-ops-review`
- **工单任务类型：** `邮件提报待审`（`unit_kind=crm.ops_review`）
- **对端 CRM：** `taskType=EMAIL_SUBMIT_AUTOMATION`（及同形态邮件提报）且 `status=PENDING_REVIEW`
- **总设计：** [../DESIGN.md](../DESIGN.md)（拉取、鉴权、对账、与订单内审隔离仍以总设计为准；**本队列写回以本文为准**）

本文只改 **邮件提报待审** 的判断与写回。订单 AI 内审（`crm-order-review` / `APPROVED`/`REJECTED`）不在范围内。

---

## 1. 问题

上游 `email-submit-automation-quote-flow` 把不敢自动处理的邮件打成 `NEED_MANUAL_REVIEW` → 运营任务 `PENDING_REVIEW`，**不外发**。现网人审本意是：人在收件箱回邮、在活动里手工提报，再关单。

旧 ops 写回只有两值，且和现网能力对不上：

| 旧 action | 现网实际 |
|---|---|
| `APPROVE_AND_CONTINUE` → `POST /approve` | 只把任务改回 `IN_PROGRESS`。进入待审时已打 `stoppedForHumanReview=true`，扫描器**不会**再跑 Agent，也**不会**发信或提报 |
| `CLOSE_TASK` → `POST /close` | 关单，不发信 |

因此「DSH 判继续，CRM 接着回邮/提报」在邮件提报待审上**落空**。本设计改为：连接器写出 **4 个决策 + 可选 scene**，由 **CRM 按配置发信/提报，再关单**（或明确留待审）。

---

## 2. 目标

1. Regenic 工单任务类型固定为 **邮件提报待审**，一行 inbox = 一条 `EMAIL_SUBMIT_AUTOMATION` 待审任务。
2. 主路径仍是：ingest → 开工单 → **DSH 判断** → 连接器自动 `complete`。不是等人在 Regenic 点按钮。
3. DSH / Skill 只输出 **决策（4 选 1）+ scene（如有）+ 可选提报价**。不调 CRM、不发信、不提报。
4. CRM 配置 scene 话术。`complete` 后由 CRM **按决策执行副作用**，再关运营任务（`LEAVE_PENDING` 除外）。
5. **决策管副作用，scene 只选题。** 两者冲突则 `400`，任务保持待审，禁止改判。
6. 操作者仍记 `regenic`。连接器不直接打发信 API / 提报 API。

---

## 3. 非目标

- 用订单内审 `APPROVED`/`REJECTED` 驱动本队列。
- 连接器或 DSH 直接发信、提报、写 `project_field_change_logs`。
- 恢复 `approve` → `IN_PROGRESS` 当「继续自动化」（邮件提报待审禁止再走这条）。
- 用 scene 名单独决定发不发、关不关（scene 不得覆盖决策）。
- P0 覆盖交付下单、静默跟进等其它 `PENDING_REVIEW` 类型。
- 把 `LEAVE_PENDING` 收成「一律回完就关」。

---

## 4. 工单与任务类型

| 项 | 值 |
|---|---|
| 驱动 | `crm-ops-review` |
| `source` | `crm` |
| 线程 | `crm:ops_task:<operationalTaskId>` |
| `unit_kind` | `crm.ops_review` |
| **工单任务类型（人读）** | **邮件提报待审** |
| `conversation_kind` | `ops_task` |
| `conversation_label` | `{项目或达人} · 邮件提报待审` |
| `thread_facet` | `ticket` |
| ingest `type` | `task` |
| Prompt `title` | `邮件提报待审` |
| CRM 过滤 | `taskType ∈ {EMAIL_SUBMIT_AUTOMATION, EMAIL_SUBMIT}` 且 `status=PENDING_REVIEW` |

Recipe 只 match：`source=crm`、`record_class=task`、`thread_facet=ticket`、`unit_kind=crm.ops_review`（或线程前缀 `ops_task:`）。禁止和 `crm:order:*` 共用一条 Recipe。

`body` 标题与人读类型一致，须够 DSH 选决策和 scene，至少包括：

- locator、`status`、`taskType`、`nextAction`（多为 `NEED_MANUAL_REVIEW`）
- `reviewGuide` 为何待审、建议下一步
- 关联订单：项目、达人、`clientRequirement`、已有报价、`quoteLifecycleStatus`（未提报 / 审核中 / 已选中 / 已拒绝）
- 关联邮件：主题、最近来信、`threadDigest` / 我方已发引导次数（`quoteGuideOutboundCount`）
- 既有 `proposedReply` 仅作参考，**写回后发信以 CRM scene 模板为准**，不以旧底稿覆盖决策

---

## 5. 四个决策（写回唯一权威）

连接器 `complete.action` **只认**下列四值（大小写敏感）。旧值 `APPROVE_AND_CONTINUE` **作废**，CRM 返回 `400`。

| action | 中文（Prompt / 审计） | CRM 必须做的事 | 关运营任务？ |
|---|---|---|---|
| `SEND_AND_CLOSE` | 发信并关单 | 用 **scene 配置的模板** 回锚点邮件；成功后关单 | 是 |
| `SUBMIT_THEN_CLOSE` | 提报后关单 | 按 `submit_quote` 走现网提报；若该 scene 有收悉稿则回一封；成功后关单 | 是 |
| `LEAVE_PENDING` | 留待真人 | **不发信、不提报、不关单**；写审计 | 否 |
| `CLOSE_ONLY` | 仅关单 | **不发信、不提报**；直接关单 | 是 |

「自动回邮然后关闭运营任务」只覆盖 `SEND_AND_CLOSE` 与 `SUBMIT_THEN_CLOSE`（后者在有收悉稿时）。`CLOSE_ONLY` 不回邮。`LEAVE_PENDING` 必须留下给真人（附件读不出、价核不出、免费也愿意做、三轮仍要细节等）。

禁止再映射到 `approve()`。邮件提报待审的成功收束只有 **`CLOSED`** 或 **仍为 `PENDING_REVIEW`**。

---

## 6. Scene：CRM 配置，连接器只传键

Scene 是话术键，不是第二种写回枚举。DSH 读信后选出 scene；CRM 用配置渲染正文（占位符取活动/达人/项目已填字段；没填的整行不写）。

连接器**不必**回整封 `email`。回了也不作为发信正文，避免和 CRM 模板双源。

### 6.1 配置项（CRM）

每条 scene：

| 字段 | 说明 |
|---|---|
| `scene` | 稳定键，与 DSH 输出一致 |
| `allowAutoSend` | 是否允许在 `SEND_AND_CLOSE` / `SUBMIT_THEN_CLOSE` 下自动外发 |
| `submit` | 为 true 时本 scene 必须带 `submit_quote` |
| `template` | 主题 + 正文模板（默认英文；语种跟锚点来邮） |

建议初始键（可增，不可 silently 改语义）：

| scene | 典型决策 | `allowAutoSend` | `submit` |
|---|---|---|---|
| `NEED_QUOTE_GENERIC` | `SEND_AND_CLOSE` | true | false |
| `NEED_QUOTE_BRIEF` | `SEND_AND_CLOSE` | true | false |
| `NEED_QUOTE_FORMAT` | `SEND_AND_CLOSE` | true | false |
| `NEED_QUOTE_BUDGET_ASK` | `SEND_AND_CLOSE` | true | false |
| `NEED_QUOTE_WHATSAPP` | `SEND_AND_CLOSE` | true | false |
| `NEED_QUOTE_GIFT` | `SEND_AND_CLOSE` | true | false |
| `NEED_QUOTE_PLATFORM_OK` | `SEND_AND_CLOSE` | true | false |
| `NEED_QUOTE_VERIFY_DOMAIN` | `SEND_AND_CLOSE` | true | false |
| `NEED_QUOTE_VERIFY_CLIENT` | `SEND_AND_CLOSE` | true | false |
| `NEED_QUOTE_STALL` | `SEND_AND_CLOSE` | true | false |
| `NEED_QUOTE_PAY_OR_DATE` | `SEND_AND_CLOSE` | true | false |
| `REJECT_OUR_NUMBER` | `SEND_AND_CLOSE` | true | false |
| `ASK_STATUS_IN_REVIEW` | `SEND_AND_CLOSE` | true | false |
| `NEED_CONTEXT` | `SEND_AND_CLOSE` | true | false |
| `MORE_NAMES` | `SEND_AND_CLOSE` 或 `SUBMIT_THEN_CLOSE` | true | 有本线程价则为 true |
| `QUOTE_PLUS_Q` | `SUBMIT_THEN_CLOSE` | true | true |
| `QUOTE_UNPARSED_RANGE` | `SUBMIT_THEN_CLOSE` | true | true |
| `REAL_HUMAN` | `LEAVE_PENDING` | **false** | false |
| `NO_FOLLOW` | `CLOSE_ONLY` | false | false |
| `NOT_OUTREACH` | `CLOSE_ONLY` | false | false |

`QUOTE_UNPARSED_BODY` / `QUOTE_UNPARSED_MULTI` / 自称已报价核不出 → 走 `REAL_HUMAN` + `LEAVE_PENDING`，不要配成可自动发。

### 6.2 决策 × scene 校验（CRM，不一致 `400`）

- `SEND_AND_CLOSE`：`scene` 必填且已配置；`allowAutoSend=true`；`submit` 不得为 true（有价应走提报）。
- `SUBMIT_THEN_CLOSE`：`submit_quote` 必填（可识别金额或区间最高价原文）；`scene` 建议有；若配置 `submit=true` 则不得缺价；若 `allowAutoSend=false` 则只提报不回邮，仍关单。
- `LEAVE_PENDING`：**即使**模板能发也不发、不关。`scene` 可空或 `REAL_HUMAN`。
- `CLOSE_ONLY`：不发信。`scene` 可空。
- 未知 `scene`、模板缺必填占位、锚点已回复、发信账号缺失 → `400`，保持待审。

发信复用邮件提报现网外发（与 `GUIDE_QUOTE_REPLY` / `NOTIFY_QUOTE` 同一套：锚点账号、未回复校验、禁止编造金额）。提报复用活动 quote submit，不新造库。

---

## 7. 端到端

```text
CRM  EMAIL_SUBMIT_AUTOMATION + PENDING_REVIEW（邮件提报待审）
  → 连接器 ingest type=task，unit_kind=crm.ops_review
  → 内核开工单「邮件提报待审」
  → Recipe（DSH）读 body：选 action + scene + 可选 submit_quote
  → 连接器 POST complete（操作者 regenic）
  → CRM：
       SEND_AND_CLOSE     → 渲染 scene 模板 → 回邮 → CLOSED
       SUBMIT_THEN_CLOSE  → 提报 → 可选收悉回邮 → CLOSED
       CLOSE_ONLY         → CLOSED
       LEAVE_PENDING      → 仍 PENDING_REVIEW，写审计
  → 已关闭：对账 tombstone，inbox 拿掉
  → 留待审：仍在 live[]，本 event 不重跑；CRM 内容 revise 才再判
```

判断者是 DSH，执行者是连接器 `complete`，副作用在 CRM。顺序不能对调，不能改成「先人点、DSH 可选」。

与上游 quote-flow 的关系：无报价且引导未满 3 轮应由上游 `GUIDE_QUOTE_REPLY` 自动回，**不应**再进本队列。本队列 DSH 选 `NEED_QUOTE_*` 时须看 `quoteGuideOutboundCount`：上游已要过 ≥2 轮，优先 `NEED_QUOTE_STALL` 或 `LEAVE_PENDING`，禁止从 0 再数两轮。

---

## 8. DSH / Prompt 输出

DSH / Skill 第一行精确匹配 **四决策或 scene 键**（内核只认第一行；scene 作为选项标签列出，不改内核）。建议：

```text
NEED_QUOTE_BRIEF
```

```text
QUOTE_PLUS_Q
```

```text
REAL_HUMAN
```

```text
NO_FOLLOW
```

也可第一行只写四决策（`SEND_AND_CLOSE` 等）；缺 scene 时 CRM 用默认话术（要价用 `NEED_QUOTE_GENERIC`，提报用 `QUOTE_PLUS_Q`）。提报价优先用连接器 `submit_quote`，没有则从锚点邮件已解析报价取最高价。

| action | 别名（仅解析） |
|---|---|
| `SEND_AND_CLOSE` | 发信并关单 |
| `SUBMIT_THEN_CLOSE` | 提报后关单 |
| `LEAVE_PENDING` | 留待真人、PENDING |
| `CLOSE_ONLY` | 仅关单、关闭任务 |

`LEAVE_PENDING` / `PENDING` / `HOLD`：**必须**调用 `complete` 且 `action=LEAVE_PENDING`（让 CRM 记账），或与内核「跳过写回」等价——实现须保证 **同一 event 不重跑**，且 **不关单、不发信**。禁止把旧逻辑「非法结论」用在 `LEAVE_PENDING` 上导致重试空转。

DSH 不得输出订单内审结论。不得直接打 CRM。无合法 action 时连接器 **不** complete、不猜决策。

`reviewGuide.allowedActions` 改为下发上述四值（可按任务收窄，例如产品不允许自动提报则不含 `SUBMIT_THEN_CLOSE`）。DSH 只能选允许的值，禁止虚构。

---

## 9. CRM `complete` 契约

```text
POST /internal/regenic/ops-tasks/{taskId}/complete
```

```json
{
  "action": "SEND_AND_CLOSE",
  "scene": "NEED_QUOTE_BRIEF",
  "submit_quote": { "raw": "800 USD", "amount": 800, "currency": "USD" },
  "comment": "source=regenic queue=ops ..."
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `action` | 是 | 四值之一 |
| `scene` | 条件 | `SEND_AND_CLOSE` 必填；其余按 §6.2 |
| `submit_quote` | 条件 | `SUBMIT_THEN_CLOSE` 必填；`raw` 必有 |
| `comment` | 是 | 审计：`source=regenic`、有无 token、提报运营 id、DSH 原文 |

规则：

- 操作者 / 审核人 = `regenic`（与是否带 JWT 无关）。
- 有 token 不能完工别人提报运营的任务 → `404`。
- 任务不是邮件提报或已不在 `PENDING_REVIEW` → `404` / `409`；连接器对账 tombstone。
- 校验失败、外发失败、提报失败 → `400` / `409`，**保持待审**，不得半关单。发信已成功但关单失败须可补偿关，禁止重复外发（幂等键：`taskId + action + scene + 锚点邮件 id`）。
- 旧 body `{ action: "APPROVE_AND_CONTINUE" }` → `400`，提示改用四值。
- `LEAVE_PENDING` 成功：HTTP 2xx，任务仍 `PENDING_REVIEW`。

列表 / 详情可继续用：

```text
GET /internal/regenic/pending-ops-tasks
GET /internal/regenic/ops-tasks/{taskId}
```

`reviewGuide.allowedActions` 与 Prompt options 必须是四值子集，不再下发 `APPROVE_AND_CONTINUE`。

---

## 10. 连接器职责（本包）

| 做 | 不做 |
|---|---|
| 拉待审、开工单「邮件提报待审」、组 body | 发信、提报、选模板 |
| 解析 DSH 的 action / scene / submit_quote | 无结论时猜 action |
| `POST complete` 原样传递 | 把四值折回 `approve`/`close` |
| 对账 tombstone（仅 CRM 已离开待审，或 `CLOSE_*` / 发信提报成功后的 `CLOSED`） | 调订单 `internal-review` |

`LEAVE_PENDING` 成功后任务仍在 `live[]`：**不** tombstone。桌面仍可见该「邮件提报待审」工单，但本 event 已完工，不自动再跑。

---

## 11. 对账（不变算法，收束条件变）

```text
stream_key = crm:pending-ops:scoped | crm:pending-ops:all
seen       = 已 ingest 未 tombstone 的 crm:ops_task:*
live[]     = 本轮仍为 PENDING_REVIEW 的邮件提报任务
```

`seen - live` → tombstone。`CLOSED` 后离开 inbox。`LEAVE_PENDING` 仍在 `live[]`。

---

## 12. 与订单内审隔离（必须遵守）

| | 本队列：邮件提报待审 | 订单 AI 内审 |
|---|---|---|
| 驱动 | `crm-ops-review` | `crm-order-review` |
| 工单类型 | **邮件提报待审** | 订单 AI 内审 |
| 写回 | `POST .../ops-tasks/{id}/complete`（四值 + scene） | `POST .../orders/{id}/internal-review` |
| 副作用 | CRM 发信 / 提报 / 关单 / 留待审 | 改内审 + change-log |

禁止一个 Prompt 同时 complete 任务又 reviewSubmit 订单。禁止「提报成功后顺便改内审」。

---

## 13. 分阶段

**本修订（P0 写回替换）**

- CRM：scene 配置；`complete` 执行四值副作用；废弃 `APPROVE_AND_CONTINUE`。
- 连接器：解析四值 + scene + `submit_quote`；Prompt 标题保持「邮件提报待审」。
- DSH Skill：按决策树出 action/scene（轮次对齐上游引导次数；核不出价 → `LEAVE_PENDING`）。

**随后**

- 待审 UI 与 `reviewGuide` CTA 与四值对齐（打开邮件仍可给真人用，不再作为写回主路径）。
- 其它运营任务类型若要复用「决策 + scene」，另开文档，不复用本四值语义。

---

## 14. 验收

1. inbox 一行 = 一条邮件提报待审；`unit_kind` 人读为「邮件提报待审」。
2. DSH 出 `SEND_AND_CLOSE` + 合法 scene：无人点击，CRM 发出与配置一致的回邮，任务 `CLOSED`，inbox 对账消失。
3. DSH 出 `SUBMIT_THEN_CLOSE` + `submit_quote`：CRM 提报成功（可选收悉信），任务 `CLOSED`。
4. DSH 出 `CLOSE_ONLY`：不发信，任务 `CLOSED`。
5. DSH 出 `LEAVE_PENDING`：不发信、不关单；CRM 仍待审；本 event 不重跑。
6. `SEND_AND_CLOSE` + `REAL_HUMAN`（`allowAutoSend=false`）→ `400`，任务仍待审。
7. `SUBMIT_THEN_CLOSE` 无 `submit_quote` → `400`，未提报。
8. 旧 `APPROVE_AND_CONTINUE` → `400`，任务仍待审，扫描器未重跑 Agent。
9. 无 DSH 合法结论：连接器不 complete。
10. 同一执行器不得改任何订单内审。
11. 操作者是 `regenic`，comment 含 action、scene、DSH 原文。

---

## 15. 已决

1. 工单任务类型 = **邮件提报待审**；CRM 对象 = 邮件提报 `PENDING_REVIEW`。
2. 写回只认四值：`SEND_AND_CLOSE` / `SUBMIT_THEN_CLOSE` / `LEAVE_PENDING` / `CLOSE_ONLY`。
3. 决策定发信、提报、关单；scene 只选题，配置在 CRM。
4. 成功路径关单，不 `approve` 回 `IN_PROGRESS`。
5. 连接器不发信、不提报；DSH 不调 CRM。
6. 主路径仍是自动 complete，不是人工点选。
7. 与订单内审队列继续解耦。
