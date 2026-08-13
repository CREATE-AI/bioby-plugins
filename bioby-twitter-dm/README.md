# bioby-twitter-dm（v0.3.6）

Chrome 侧边栏扩展：CRM 登录拉线索 → 半自动/批量发私信（发送后校验）→ 一键同步对话抽报价。

## 安装 / 更新

1. `chrome://extensions` → 开发者模式 → **加载已解压的扩展程序**（或已加载则 **重新加载**）
2. 点击工具栏图标 → 右侧打开 **侧边栏**
3. 设置里填写 API Base、Campaign ID、CRM 账号密码 → **登录并保存**
4. X 聊天解锁码（默认 `1234`，仅本机）
5. **本机 Chrome 需已登录 X**

## 发私信（单条 / 批量）

**单条**：选话术 → 点卡片 **发送私信**

**批量**：设置 **发送量** / **间隔(秒)** → **一键发送**（可 **停止**）

插件会先确认 UI 结果再回写 CRM（避免假成功）：

| 场景 | contactStatus |
|------|---------------|
| 真正发出（OUT 气泡可见且无 Failed） | `PLUGIN_CONTACTED` |
| 对方拒收/关私信 | `SEND_FAILED_DM_REJECTED` |
| 日额度不足（点 Not Now） | `SEND_FAILED_RATE_LIMIT` |
| 需 Premium/认证（点 No thanks） | `SEND_FAILED_PREMIUM` |
| 其它失败 | `SEND_FAILED` |
| 人工跳过 | `SKIPPED` |

批量汇总示例：`成功 a，Premium b，额度 c，拒收 d，其它失败 e`

## 收录 DM / 报价

- **具体达人线索**：选择要收录的达人
- **消息方向**：IN=达人回复（自动抽报价），OUT=我方发出
- 或点 **同步全部对话并抽报价** 批量抓取

## 文件

| 文件 | 作用 |
|------|------|
| `sidepanel.html/js/css` | 侧栏 UI、批量发送、状态回写 |
| `background.js` | 开 tab、编排发送/同步 |
| `xDom.js` + `content.js` | 弹窗检测、发送校验、抓会话 |
