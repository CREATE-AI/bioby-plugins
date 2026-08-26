# @bioby/regenic-crm-connector

私有 Regenic 渠道插件。公开默认构建不要注册。

## 环境变量

| 变量 | 必填 | 作用 |
|---|---|---|
| `REGENIC_CRM_BASE_URL` | 是 | CRM 内网基址，须含 `/api`，例如 `https://crm-host/api` |
| `REGENIC_CRM_TOKEN` | 否 | 有则只拉该提报运营的待审对象；非法 token 必须 `401`，不得降级成全量 |

写回审核人 / 操作者一律由 CRM 记为 `regenic`，与是否带 token 无关。

公开引擎页已有 CRM 安装卡片。没有本包时卡片会显示，但前置条件不满足，装不上。

本机把包放到与 `regenic` 同级的 `bioby-plugins/regenic-crm-connector`，或设置 `REGENIC_CRM_CONNECTOR` / 装好 `@bioby/regenic-crm-connector`，再设 `REGENIC_CRM_BASE_URL` 后即可在引擎页安装。

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
  env: process.env,
});
await host.plugin(crmOrderReviewPlugin, {
  installation_id,
  org_id,
  env: process.env,
});
```

可只挂其中一个。两个驱动共用 `source=crm`，靠 `ownsThread` 按 `ops_task:` / `order:` 分流。

## 两条队列

- `crm-ops-review`：邮件提报 `PENDING_REVIEW` → DSH 结论 → `POST .../ops-tasks/{id}/complete`
- `crm-order-review`：AI 内审待人工 → 结论 → `POST .../orders/{id}/internal-review`

禁止互相调用。连接器不发信、不提报、不单独打 change-log。无 DSH / 执行器结论时不得自行 complete。

## 依赖

对 `@regenic/domain`、`@regenic/plugin-host` 使用本地 `file:` 或内部 workspace，不要做成公开仓子包。
