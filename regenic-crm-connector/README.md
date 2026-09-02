# @bioby/regenic-crm-connector

私有 Regenic 渠道插件。公开默认构建不要注册。

## 连接器配置

安装 / 编辑连接器时在 Engine 表单填写，不要用启动环境变量指定 CRM 地址。

| 字段 | 必填 | 作用 |
|---|---|---|
| `base_url` | 是 | CRM 内网基址，须含 `/api`，例如 `https://crm-host/api` |
| `max_open_tasks` / `max_open_order_reviews` | 否 | 同时进行中的 AI 上限，默认 50。邮件提报里 `LEAVE_PENDING` / complete 400 不占坑 |

## 环境变量

| 变量 | 必填 | 作用 |
|---|---|---|
| `REGENIC_CRM_CONNECTOR` 或 `REGENIC_PLUGIN_DIR` | 是 | 让公开引擎加载本私有包 |
| `REGENIC_CRM_SHARED_SECRET` | 生产必填 | 与 CRM 的 `INTERNAL_AUTH_REGENIC_SHARED_SECRET` 相同。请求头 `X-Internal-Service: regenic` + `X-Regenic-Key`。不要放进 `REGENIC_CRM_TOKEN` |
| `REGENIC_CRM_TOKEN` | 否 | 提报运营的 **JWT**。有则只拉该账号的待审对象；非法 JWT 必须 `401`，不得降级成全量 |
| `REGENIC_CRM_REQUEST_TIMEOUT_MS` | 否 | CRM HTTP 截止，默认 `120000`（2 分钟）。须小于内核 poll/sync 超时 |

写回审核人 / 操作者一律由 CRM 记为 `regenic`，与是否带 token 无关。

生产待人工列表可能一次 30s+/数 MB。内核还要加长 poll/sync，否则仍会在 HTTP 成功前被掐掉：

```bash
export REGENIC_CONNECTOR_POLL_TIMEOUT_MS=120000
export REGENIC_CONNECTOR_SYNC_TIMEOUT_MS=180000
```

公开引擎页有安装卡片，但开源仓不会自动发现本包。本机先指到这个目录，再在连接器表单里填 CRM 地址：

```bash
export REGENIC_CRM_CONNECTOR="$HOME/Documents/git/bioby-plugins/regenic-crm-connector"
# 或：export REGENIC_PLUGIN_DIR="$HOME/Documents/git/bioby-plugins"
```

运营和订单是两张 singleton 卡片，同一 CRM 要各填一次 `base_url`，不要互相读对方的 installation。

旧安装若只设了 `REGENIC_CRM_BASE_URL`、config 里没有 `base_url`，sync 仍会回退环境变量。点编辑保存时必须在表单填写含 `/api` 的地址，否则会失败。

## 内部挂载

驱动由公开 API 在能解析到本包时自动 `register`。`host.plugin` 仍由驱动在 sync 时挂上。若要手写：

```ts
import {
  crmOpsReviewDriver,
  crmOrderReviewDriver,
  crmOpsReviewPlugin,
  crmOrderReviewPlugin,
} from "@bioby/regenic-crm-connector";

drivers.register(crmOpsReviewDriver);
drivers.register(crmOrderReviewDriver);

await host.plugin(crmOpsReviewPlugin, {
  installation_id,
  org_id,
  base_url: "https://crm-host/api",
  env: process.env,
});
await host.plugin(crmOrderReviewPlugin, {
  installation_id,
  org_id,
  base_url: "https://crm-host/api",
  env: process.env,
});
```

可只挂其中一个。两个驱动共用 `source=crm`，靠 `ownsThread` 按 `ops_task:` / `order:` 分流。

## 两条队列

- `crm-ops-review`：工单类型 **邮件提报待审**。邮件提报 `PENDING_REVIEW` → DSH 四决策 + scene → `POST .../ops-tasks/{id}/complete`。写回约定见 [docs/ops-review-email-submit.md](docs/ops-review-email-submit.md)。
- `crm-order-review`：AI 内审待人工 → 结论 → `POST .../orders/{id}/internal-review`

禁止互相调用。连接器不发信、不提报、不单独打 change-log。无 DSH / 执行器结论时不得自行 complete。

## 依赖

对 `@regenic/domain`、`@regenic/plugin-host` 使用本地 `file:` 或内部 workspace，不要做成公开仓子包。

`npm test` / `npm run build` 要求本机在同级目录有 `regenic` 仓库（`../../regenic/packages/domain` 与 `plugin-host`）。单独 clone `bioby-plugins` 跑不了测试。
