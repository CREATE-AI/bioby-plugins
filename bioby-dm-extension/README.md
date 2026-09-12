# bioby-dm-extension

Bioby **交付私信全自动** Chrome 扩展（Manifest V3）。对接 bioby-email 的 `/api/auto-dm-delivery/plugin/*`。

**同一台电脑、一个「全自动」开关**，可同时挂 **Instagram + TikTok**（在对应卡片勾选「自动发送」并填商务号）。

## 开发

```bash
cd bioby-dm-extension
npm install
npm run dev
```

Chrome → `chrome://extensions` → 开发者模式 → **加载已解压的扩展程序** → 选择 `dist` 目录（`npm run dev` 会生成并监听）。

## 生产构建

```bash
npm run build
```

加载 `dist` 目录。

## 使用

1. 侧栏填写 **后台地址**、同步 **工作台登录**（或开启 **Mock API**，见下）。
2. 在 **Instagram / TikTok 卡片**勾选「自动发送」，再填写对应 **商务号编号**（须与后台一致）。
3. 本机 Chrome **分别登录** IG、TikTok 商务号（两个网站都要能发私信）。
4. **检查连接是否正常** → 开启 **自动发私信**。两渠道并行领任务、各自间隔随机。

日常运营：**勾选要用的平台 → 填商务号 → 保存 → 检查连接 → 开自动**。

验证码/选器失败等会 **熔断该渠道**；点 **解除 IG/TT 熔断** 可本地恢复后继续（后端 `halted` 仍须一致时再调心跳）。

## Mock API（后端未就绪时）

1. 勾选 **Mock API**，填写 **Mock 达人主页 URL**（须与要测的平台一致，如 IG 主页链接）。
2. 可选填 **Mock 私信正文**。
3. 填任意 **accountLabel**（Mock 不校验 Token），点 **试发 IG/TT 一条** 或开全自动。

`mark-sent` / `mark-failed` / `report-reply` 仅打控制台日志，便于先验 DOM 流程。

## 回复侦测

- 心跳响应中的 `observationTasks`（或 `observationTaskIds` + handle）会写入本地观察列表。
- 每 **5 分钟** 自动打开收件箱扫描未读；也可点 **扫描回复**。
- 检出后调用 `POST .../report-reply`（Mock 模式下仅日志）。

后端需返回带 `influencerHandle` 的 `observationTasks`，否则无法匹配线程。

## 说明

- 页面 DOM 易变，`src/content/*.ts` 与 `src/selectors/*.json` 需真机迭代。
- 发送成功会轮询页面文案/ composer 是否清空，减少误报。
- 单渠道硬失败会熔断该渠道；**全部已启用渠道都熔断** 时才会自动关掉总开关。
- 后端 `claim-next` 按 `platform` 过滤 `IG_DM` / `TIKTOK_DM` 任务。
