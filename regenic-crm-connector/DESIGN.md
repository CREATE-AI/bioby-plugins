# Regenic CRM 连接器设计

- **状态：** 草案（P0 主路径：**DSH 判断 → 连接器自动 complete**，不以人工点选为主）
- **仓库：** `CREATE-AI/bioby-plugins`（私有）
- **目录：** `regenic-crm-connector/`
- **公开仓：** 不进入 `regenic-ai/regenic` 默认构建
- **依赖契约：** Regenic 连接器合同、RFC 0008、RFC 0009
- **对端：** 两条解耦队列——① 邮件提报待审（P0）② 订单 AI 内审待人工（P1）
- **P0 写回真源：** [docs/ops-review-email-submit.md](docs/ops-review-email-submit.md)（四决策 + CRM scene；**不要**再按本文旧的 `approve`/`close` 实现）

本文只描述内部 CRM 渠道如何挂到 Regenic。邮件提报待审的决策、scene、`complete` 字段以专项文档为准；本文保留拉取、鉴权、对账与和订单队列的隔离。

---

## 1. 问题

运营在 CRM 里卡住的，经常不是「给订单点个内审通过」，而是 **邮件提报运营任务** 停在 `PENDING_REVIEW`：当初自动化不敢回邮/提报，把单交给人。

这条在 Regenic 里的处理逻辑 **不得改成人工点选**：

1. 连接器把待审任务拉进来（自动开工单）
2. **DSH 阅读上下文并判断**该如何处理（四决策 + 可选 scene，见专项文档）
3. 内核把结论交给连接器 `complete`，**自动**写回
4. CRM 按决策发信 / 提报 / 关单，或明确留待审（**不再** `approve` 回 `IN_PROGRESS`）

人可以看 inbox 里的过程，但 **P0 产品路径不是等人点「继续/关闭」**。DSH 判不了时才允许停住，不默认改回人工主路径。

只在订单上点内审通过/不通过，仍然不会让运营任务往下走。

---

## 2. 目标

1. 私有插件，内部构建挂上，公开默认不装。
2. **P0 主拉取：`taskType=EMAIL_SUBMIT_AUTOMATION` 且状态 = `PENDING_REVIEW` 的运营任务**（及同形态的邮件提报待审）。有 token 只拉 **提报运营 = 该账号** 的任务；无 token 拉全部。
3. **P0 固定链路（不可改成人工主路径）：** ingest → 开工单（任务类型 **邮件提报待审**）→ **DSH 判断** → 连接器按结论自动 `complete`。CRM 按四决策执行（详见专项文档）：
   - `SEND_AND_CLOSE` → scene 模板回邮成功 → 关单 + 锚点标星
   - `SUBMIT_THEN_CLOSE` → 尝试提报 → 可选收悉（仅成功）→ 关单 + 锚点标星（提报成败都关）
   - `CLOSE_ONLY` → 不发信，关单 + 锚点标星
   - `LEAVE_PENDING` → 不发信、不关单、不标星
   DSH 只出结论，不调 CRM、不发信。连接器只传递结论，不代替 DSH 判断，不直接发信/提报。
4. 操作人记为 `regenic`（与是否带 token 无关）。token 只限制读/写范围。
5. 一条运营任务 = 一条线程，线程上只有一条 `task`。关联订单、邮件是上下文，不是第二张工单。
6. `body` 必须够 DSH 判断：为何待审、底稿、关联订单/邮件。打开线程可看过程，不是等人审批。
7. 公开默认路径不写 `if (source === "crm")`；内部包装注册驱动。
8. **P1 独立队列：** 拉「AI 内审 = 待人工」的订单，ingest 后由内核自动开工单，执行器自动判断，再经**另一条**写回改内审结果，并由 CRM 记订单 change-log。与 P0 运营任务队列禁止互相调用。

订单内审 **不是** P0 按钮。P0 不靠订单 `APPROVED`/`REJECTED` 驱动回邮/提报。P1 不靠运营任务 `approve`/`close` 改内审。

---

## 3. 非目标

- 连接器直接调发信 API 或提报 API（必须走 `complete`，由 CRM 按决策和 scene 配置执行）。
- 在 Regenic 里创建 CRM 订单或运营任务。
- 把 CRM 做成第二条聊天通道。
- import `bioby-email` 源码。
- 用订单内审「通过/不通过」冒充任务收束；用任务 `approve`/`close` 冒充改内审。
- 同一线程两条 `task`；两条队列共用一个 Prompt / 一个写回 URL。
- 连接器或执行器直接写 `project_field_change_logs`（必须走 CRM 内审写回，由 CRM 记账）。
- 执行器 import CRM HTTP 或本包 `crm-client`（DSH 只读工单正文，写回只经连接器 `complete`）。
- 把邮件提报 `PENDING_REVIEW` 的主路径改成「等人在 Regenic 点继续/关闭」。
- 公开默认 `CATALOG` 写入 CRM。
- P0 覆盖交付下单、长时间未回复等其它 `PENDING_REVIEW` 类型（P1 按同一「完工 → CRM 动作」模式加）。

---

## 4. 为什么比「订单点通过/不通过」合理

现网邮件提报：Agent 判成 `NEED_MANUAL_REVIEW` → 任务 `PENDING_REVIEW`，**不自动外发**。旧 `approve` 只把任务打回 `IN_PROGRESS`，扫描器因 `stoppedForHumanReview` **不会**接着回邮/提报。因此本队列写回不再冒充「继续自动化」，改为四决策 + CRM scene。完整约定见 [docs/ops-review-email-submit.md](docs/ops-review-email-submit.md)。

判断者是 **DSH**，执行者是 **连接器 complete**，副作用在 **CRM**。不是订单 `reviewSubmit`。这条顺序不能对调、不能改成「先人点、DSH 可选」。

```text
CRM 任务 PENDING_REVIEW（邮件提报待审）
        → 连接器拉进 Regenic，开工单「邮件提报待审」
        → Recipe 启动 DSH：输出 action + scene + 可选 submit_quote
        → 连接器自动 complete（操作者 regenic）
        → CRM 按 scene 配置发信/提报，再关单（或 LEAVE_PENDING 留待审）
        → 已关闭则折进「不显示」（与订单 AI 内审相同），不 tombstone
```

---

## 5. 放置与边界

```text
bioby-plugins/regenic-crm-connector/    # @bioby/regenic-crm-connector
```

| 包 | 职责 |
|---|---|
| `@regenic/domain` / `@regenic/plugin-host` | 公开端口 |
| 本包 | 两个驱动共用 HTTP 工具，**业务入口分开**：`crm-ops-review`（执行 DSH 结论）/ `crm-order-review` |
| DSH 执行器 | 只读 ops 工单正文并给出动作；**不**调 `complete`、不调 CRM |
| CRM | P0：`complete` 四决策 + scene 配置（发信/提报/关单/留待审）。P1：现网内审写回 + **顺带** `OPERATION` change-log。两套 URL，互不转发 |
| 内部 api/desktop | register 驱动 + `host.plugin` |

---

## 6. 分层

| CRM 事实 | L2 | 说明 |
|---|---|---|
| 待审运营任务 | `task` | 线程上唯一 task |
| 任务仍待审、字段变了 | `revise` | 仍在当前工作 |
| 已关单 / 删除 | **折进「不显示」** | 事件保留，Hidden 可打开；`LEAVE_PENDING` / parked 同样折进「不显示」（与订单 AI 内审、内核 done fold 一致） |
| 邮件正文、订单摘要 | `body` / 以后 `utterance` | 不是第二张 task |
| DSH 结论 → 四决策 + scene | 执行器结果，经连接器 complete | 不入库为人话气泡 |

---

## 7. 领域与 Locator

**一条待审运营任务 = 一条线程。**

```text
线程  crm:ops_task:<operationalTaskId>
  ├─ task 头     待人工原因、nextAction、建议回邮/是否可提报
  ├─ 上下文      关联 ProjectField、邮件线程（写在 body）
  └─ DSH 结论    四决策 + scene → 连接器自动 complete
```

| 对象 | locator | 现网主键 |
|---|---|---|
| 运营任务 | `crm:ops_task:<taskId>` | `operational_task_instances.id` |
| 关联订单（上下文） | `crm:order:<projectFieldId>` | `businessRef.projectFieldId`，**P0 不单独占 inbox** |
| 邮件正文（P1） | `crm:mail:<messageId>` | 邮件 id，≠ 任务 id |

线程 id：`crm:ops_task:<taskId>` → `source=crm`，`target=ops_task:<taskId>`。

---

## 8. 记录映射

| CRM 事实 | 记录 | `external_id` |
|---|---|---|
| 进入待审 | create `task` | `crm:ops_task:<taskId>` |
| 待审中更新（底稿、指引变了） | revise `task` | 不变 |
| 已关单 / 消失 | 折进「不显示」 | 不变；parked（LEAVE_PENDING）同样折 |
| DSH 结论写回 | 连接器 `complete`（机器调用，不是等人点） | `crm:ops:<taskId>` |

`conversation_label`：`{项目或达人} · 邮件提报待审`。`list_title`：`conversation`。

---

## 9. 上下文（P0 全在 body，给 DSH 看）

`body` 是 DSH 判断的输入，不是等人审批的卡片。至少包括：

- 任务 locator、状态、`taskType`、`nextAction`（如 `NEED_MANUAL_REVIEW`）
- Agent 为什么转人工（`reviewGuide.headline` / rationale）
- 建议下一步（四决策口径：发信关单 / 提报关单 / 留待审 / 仅关单；不要打开收件箱）
- 引导轮次、`quoteLifecycleStatus`（DSH 选 scene 用）
- 关联订单：项目、`clientRequirement` 摘要、达人、报价
- 关联邮件：主题、锚点最近来信正文摘要（不是 rationale）、`threadDigest`、解析报价 / 附件数、`proposedReply` 底稿
- `crm:mail:<id>` 是 P1 资源，P0 不作为可拉取 locator；全文写在 body 里

metadata 可另存结构化 JSON，P0 验收不依赖桌面能画 JSON。

---

## 10. 拉取、范围、对账

### 10.1 过滤

状态：运营任务 `PENDING_REVIEW`，P0 限 `EMAIL_SUBMIT_AUTOMATION`（及邮件提报待审 kind）。

CRM 两层鉴权互不替代：

| 层 | CRM | 连接器 |
|---|---|---|
| 调用方密钥 | 生产 `internal.auth.regenic.enabled=true`，校验 `X-Internal-Service: regenic` + `X-Regenic-Key` = `INTERNAL_AUTH_REGENIC_SHARED_SECRET` | `REGENIC_CRM_SHARED_SECRET`。未开调用方鉴权的本地 CRM 可不设 |
| JWT 范围 | `Authorization: Bearer`：无 token=全量；非法 token=`401`，不得降级 | `REGENIC_CRM_TOKEN`，必须是用户 JWT，**不是**共享密钥 |

| 连接器 | CRM |
|---|---|
| 有 `REGENIC_CRM_TOKEN` | 仅提报运营 = token 用户（任务或其关联 `ProjectField.reportingOperationsUserId`，CRM 写死一种） |
| 无 token | 全部待审（内网） |
| 非法 token | `401`，不得变全量 |

未分配提报运营的任务：只出现在无 token。`max_open_tasks` 默认 50。

连接器表单：`base_url` 必填（含 `/api`）。环境变量：生产设 `REGENIC_CRM_SHARED_SECRET`（调用方密钥）；`REGENIC_CRM_TOKEN` 选填（JWT 范围）。不要用启动环境变量指定 CRM 地址。旧安装仅有 `REGENIC_CRM_BASE_URL` 时 sync 仍回退 env；重新保存必须走表单。

### 10.2 对账

```text
stream_key = crm:pending-ops:scoped | crm:pending-ops:all
seen       = 已 ingest、仍待审的 crm:ops_task:*（含 parked）
occupying  = seen 中尚无终端 Regenic 结论的，占 max_open_tasks
parked     = 有 regenicComplete（含 LEAVE_PENDING）或 regenicLastAttempt
```

`live[]` = occupying + newcomers（**不含** parked）。新的 create，变了 revise，`seen - live` 且已关单或 parked → 折进「不显示」（不 tombstone）。`LEAVE_PENDING` / complete 400 不占窗口。不能只靠列表 cursor 发现「已继续/已关闭」。

### 10.3 CRM 接口（须配合改）

列表 / 详情可以新做 internal，写回**不要另造一套业务**，包一层现网接口即可。

```text
GET  /internal/regenic/pending-ops-tasks
GET  /internal/regenic/ops-tasks/{taskId}
POST /internal/regenic/ops-tasks/{taskId}/complete
     body: {
       action: "SEND_AND_CLOSE" | "SUBMIT_THEN_CLOSE" | "LEAVE_PENDING" | "CLOSE_ONLY",
       scene?: string,
       submit_quote?: { raw: string, amount?: number, currency?: string },
       comment: string
     }
```

字段、校验、scene 配置与副作用见 [docs/ops-review-email-submit.md](docs/ops-review-email-submit.md) §5–§9。

- 操作者 / 审核人字段 = `regenic`
- `comment` 带审计：`source=regenic`、有无 token、提报运营 id、DSH 原文（含 action/scene）
- 有 token 时不能完工别人提报运营的任务（`404`）
- 任务已不在 `PENDING_REVIEW` 且不是本轮刚关单 → `409`，连接器对账折进「不显示」
- complete 成功必须回任务快照：关单动作的 `status` 不再是待审；`LEAVE_PENDING` 必须带 `regenicComplete`。空 204 仅兼容旧环境
- 同一 action 可幂等续跑（关单没落盘则再 close，已提报不再提一次）。`SUBMIT_THEN_CLOSE` 业务拒绝后关单+标星并 2xx；`SEND_AND_CLOSE` 发信失败及其它 500 / 未知 scene 写 `regenicLastAttempt` 并保持待审
- **禁止**再把 `complete` 折成现网 `approve`（邮件提报待审不会接着跑）
- 发哪封信由 CRM scene 配置决定，连接器只传 scene 键，不传正文、不选模板

订单 AI 内审写回不在 P0。订单进入待人工内审后走 **§16**，另开线程，不复用本任务的 Prompt。

---

## 11. DSH 判断 + 连接器自动 complete（逻辑不可改）

P0 邮件提报 `PENDING_REVIEW` **必须**走：

```text
Recipe（只 match crm:ops_task:* ，executor_type=dsh）
  → DSH 读 body
  → 输出动作 ∈ 该任务 reviewGuide 允许的 CTA
       SEND_AND_CLOSE | SUBMIT_THEN_CLOSE | LEAVE_PENDING | CLOSE_ONLY
       + scene（发信/提报时）+ submit_quote（提报时）
  → 内核把动作交给连接器
  → 连接器 POST complete（自动，不等人）
```

DSH 不得输出「改订单内审」。不得直接打 CRM。连接器不得在无 DSH 结论时自己猜决策。

`reviewGuide.allowedActions` 为四值子集。DSH 只能选其中之一，禁止虚构，禁止再输出 `APPROVE_AND_CONTINUE`。

DSH 失败 / 输出非法动作：工单停在可重跑，**不** complete，**不**把主路径改成等人点按钮。桌面可看状态，人工点选不是设计内的主交互。

禁止用 `egress.send` 当完工。发信只发生在 CRM 收到 `SEND_AND_CLOSE` / `SUBMIT_THEN_CLOSE` 并渲染 scene 之后。

| 能力 | P0 |
|---|---|
| `sync` | true |
| `prompts` | 给执行器交卷用，不是给人审主 UI |
| `reply` / `create` / `hydrate_on_open` | false |
| `list_title` | `conversation` |

---

## 12. 挂载

内部包装：`ChannelDriverRegistry.register` + `host.plugin`。公开默认不注册。

```text
connector_type: crm-ops-review | crm-order-review   # 两个驱动，同一 source
source:         crm
ownsThread:     target 前缀 ops_task:  vs  order:
```

可只挂其中一个。挂两个时用 `ownsThread` 按 locator 前缀分流，禁止一个驱动认走另一种。

---

## 13. 分阶段

**P0**

- CRM：待审任务列表/详情 + `complete` 四决策 + scene 配置（见专项文档）
- 拉 `PENDING_REVIEW` 邮件提报任务；工单类型 **邮件提报待审**；body 够 DSH 判断
- **Recipe + DSH 判断 → 连接器自动 complete**（主路径，不可改成人工）
- seen 对账 + 折进「不显示」
- token = 提报运营；写回人 `regenic`
- 内部挂载

**P1**

- **§16 订单内审队列**（独立驱动、独立流、独立写回 + CRM change-log）
- 其它待审运营任务类型仍走 P0 的 `complete`，不进 §16
- 邮件 utterance、hydrate（仍挂在 ops 线程，不是订单线程）

**P2**

- order 队列 Recipe + 执行器自动判内审（另条 Recipe，禁止和 ops 共用一条 match）
- Webhook
- 深链

---

## 14. 验收

1. 公开默认构建无 CRM 安装项。
2. 内部：inbox 一行 = 一条待审邮件提报任务；locator 能打开该运营任务。
3. 有 token 只见该提报运营的任务；非法 token 401。
4. `body` 足够 DSH 判断为何待审、关联订单/邮件。
5. DSH 判 `SEND_AND_CLOSE` / `SUBMIT_THEN_CLOSE` 后**无人点击**：连接器自动 complete → CRM 按 scene 回邮和/或提报并关单；inbox 对账消失。
6. DSH 判 `CLOSE_ONLY`：不回邮，关单。判 `LEAVE_PENDING`：不回邮、不关单，本 event 不重跑。
7. 只改订单内审、DSH 未出结论：任务仍待审（证明不是订单按钮在驱动）。
7b. 专项文档 §14 的校验用例（错误 scene / 缺价 / 旧 `APPROVE_AND_CONTINUE`）须一并过。
8. 无 DSH 结论时连接器不得自行 complete。
9. 操作记录上的人是 `regenic`，comment 含 DSH 结论原文。
10. P1 订单内审见 §16.6；与本表 5–7 互斥。

---

## 15. 已决与待确认

**已决**

1. P0 主对象 = 邮件提报 **PENDING_REVIEW 运营任务**。
2. **判断 = DSH，执行 = 连接器 complete → CRM 按四决策 + scene 发信/提报/关单/留待审。主路径不是人工。此条不可改。**
3. 连接器不直接发信、不直接提报；话术在 CRM scene 配置。
3b. 邮件提报待审禁止再走 `approve` → `IN_PROGRESS`。
4. 账号范围 = 提报运营；写回身份 = `regenic`。
5. 已完成离开「显示」栏 = 折进「不显示」（与订单 AI 内审相同），不 tombstone。
6. 一线程一 task：P0 = 运营任务；P1 = 待内审订单。
7. 订单内审与运营任务解耦：见 §16。

**待确认**

1. 有 token 时「提报运营」挂在任务字段上还是关联 `ProjectField.reportingOperationsUserId`。
2. `REGENIC_CRM_TOKEN` 如何解成该用户 id。
3. ~~`NEED_MANUAL_REVIEW` 过审后是否回 `IN_PROGRESS`~~ **已决：否**，见专项文档。
4. 内部包装仓路径。

确认 1～2 后，CRM `complete` 与连接器解析可按专项文档并行改。§16 不挡 P0。

---

## 16. P1 队列：订单 AI 内审（与 P0 解耦）

P0 解决「任务卡住，**DSH 判完**后连接器自动让 CRM 回邮/提报」。本节省的是另一件事：订单已经在 CRM，**AI 内审状态 = 待人工**，要拉进 Regenic、自动开工单、自动（或人工）判断，再改内审结果，并留下订单 change-log。

两条队列可以同时挂，但 **业务上不相干**。

### 16.1 解耦规则（必须遵守）

| | 队列 A：运营任务（§1–11） | 队列 B：订单内审（本节） |
|---|---|---|
| 驱动 | `crm-ops-review` | `crm-order-review` |
| 线程 | `crm:ops_task:<taskId>` | `crm:order:<projectFieldId>` |
| 流 | `crm:pending-ops:scoped\|all` | `crm:pending-review:scoped\|all` |
| 谁判断 | DSH（P0 必挂 Recipe） | 执行器或停住（P1） |
| 写回触发 | DSH 结论 → 自动 complete | 内审结论 → internal-review |
| 写回 | `POST .../ops-tasks/{id}/complete` → 四决策 + scene | `POST .../orders/{id}/internal-review` → `reviewSubmit` |
| 副作用 | CRM 按 scene 发信 / 提报 / 关单 / 留待审 | CRM 改内审 + **记 change-log** |
| Recipe | 只 match `ops_task:` | 只 match `order:` |

禁止：

- 一个 Prompt 同时 complete 任务又 reviewSubmit 订单。
- 执行器或连接器在判完订单后「顺便」approve 关联运营任务，或反过来。
- 共享 `seen` 集合、共享 `prompt_id` 前缀。
- 执行器拿 CRM token 自己 PATCH 订单。

允许共享（基础设施，不是业务耦合）：`REGENIC_CRM_*`、token→提报运营、审核人 `regenic`、离开待审折进「不显示」的对账算法、`crm-client` 的 HTTP/鉴权。

关联只许出现在 **只读上下文**：ops 线程的 body 可写「关联订单 id」；order 线程的 body 可写「关联任务 id」。点哪条只完工哪条。

### 16.2 拉什么

`ProjectField` 上 AI 内审 = 待人工，且 **不是** 自动内审 `IN_PROGRESS`。

范围与 P0 相同：有 token → `reportingOperationsUserId` = 该账号；无 token → 全部（内网）。未分配提报运营只出现在无 token。`max_open_order_reviews` 单独上限，默认 50，不占用 ops 的 `max_open_tasks`。

### 16.3 工单怎么来（连接器不「建单」）

连接器只 ingest `type=task`。内核见 `task` 自动开 WorkItem（现网 `shouldOpenWorkItem`）。连接器 **不得** 调「创建工单」API。

自动判断是 **另一条缝**：

```text
ingest task
  → 内核开工单
  → Recipe（仅 match source=crm 且 thread 为 crm:order:*）
  → TaskExecutor（DSH / 内审 skill）只读 body/metadata
  → 结论回到本线程 Prompt（通过 / 不通过 + 原因）
  → 连接器 answerPrompt → CRM internal-review
```

没有 Recipe 时：工单停在「待人点 Prompt」，不自动写回。  
执行器失败：不写回，工单可重跑；CRM 内审保持待人工。

### 16.4 写回与 change-log

```text
POST /internal/regenic/orders/{projectFieldId}/internal-review
body: { result: "APPROVED" | "REJECTED", comment: string }
```

CRM 内部必须一次做完（一个事务/一个服务方法）：

1. 走现网内审流水（与 AI 内审相同，`reviewerId` / `reviewerName` = `regenic`）。
2. 写一条 `ProjectFieldChangeLog`，`changeType=OPERATION`（与现网 Agent 自动内审一致，不可回滚）。
3. log 的 `operatorId` / `operatorName` = `regenic`；`changes` 或备注含：旧→新内审状态、结论、comment 审计前缀（`source=regenic-order-review`、有无 token、提报运营 id）。

连接器 **禁止** 再调 `POST /fields/{id}/change-logs`。漏记 log 是 CRM 写回实现的 bug，不是连接器第二步。

P1 仍只有 `APPROVED` / `REJECTED`。非法 token `401`；越权 `404`；仍是 `IN_PROGRESS` → `409`。

### 16.5 Prompt 与对账

```text
prompt_id: crm:audit:<projectFieldId>
options:   通过 → APPROVED ； 不通过 → REJECTED
```

对账流独立：`seen` 只含 `crm:order:*`。离开待人工 → 折进「不显示」，不动任何 `ops_task` 线程。

### 16.6 验收（仅本队列）

1. 不挂 `crm-order-review` 时，待内审订单不进 inbox；挂 ops 驱动仍只见运营任务。
2. 挂上后：一行 = 一条待内审 `ProjectField`；`crm:order:<id>` 能 GET 回该订单。
3. ingest `task` 后出现 WorkItem，无需连接器调建单接口。
4. 绑定仅 match `order:` 的 Recipe 后，执行器可自动给出通过/不通过；写回后 CRM 内审变更，**且** change-log 多一条 `OPERATION`。
5. 同一执行器跑完 **不得** 改变任何运营任务状态。
6. 只调用 change-log 接口、不走 internal-review：内审状态不变（证明 log 不是旁路写）。
7. 对账把订单线程折进「不显示」后，关联的 ops 线程若仍待审则仍在「显示」栏。

### 16.7 待确认（本队列）

1. 「AI 内审 = 待人工」的准确字段（`submitWorkflow` / fit-eval）。
2. 自动内审 `IN_PROGRESS` 与本队列的互斥是否一律 `409`。
3. change-log 的 `changes[]` 字段清单（至少内审状态 + 审核人）。

