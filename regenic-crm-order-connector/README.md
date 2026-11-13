# CRM 交付订单和项目连接器

私有插件。开启后自己读 CRM 的 MongoDB，把选中品牌下的交付订单和项目推进 Regenic 会话。不走 CRM 的 HTTP，也不改 CRM。不选品牌就不会同步。

和 `regenic-crm-connector` 分开。AI 内审仍是 `crm:order:<订单id>`。这里的订单会话是 `crm-delivery:<订单id>`，项目会话是 `crm-project:<项目id>`。两个连接器分开安装。

做法见 [DESIGN.md](./DESIGN.md)。

## 安装

跑这个插件的 Regenic 进程要能连上 CRM 的 MongoDB。连接串填在安装表单里，是普通文本，留在安装配置里，设置页上能看到。点过一次同步之后，Regenic 重启也会在大约 8 秒后把推送重新拉起，之后每 20 秒检查一次。配置变了会按新配置重开。

用 `REGENIC_PLUGIN_DIR` 指到 `bioby-plugins`，或用 `REGENIC_CHANNEL_PLUGIN` 指到本目录。

## 开发

```bash
npm install
npm test
```
