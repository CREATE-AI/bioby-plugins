# CRM 交付订单连接器

私有插件。直接读 CRM 的 MongoDB，把还在交付中的订单收成 Regenic 会话。不走 CRM 的 HTTP，也不改订单。

和 `regenic-crm-connector` 分开。AI 内审仍是 `crm:order:<订单id>`。这里的会话是 `crm-delivery:<订单id>`。

做法见 [DESIGN.md](./DESIGN.md)。

## 安装

跑这个插件的 Regenic 进程要能连上 CRM 的 MongoDB。连接串填在安装表单里，会进钥匙串，不留在安装配置里。

用 `REGENIC_PLUGIN_DIR` 指到 `bioby-plugins`，或用 `REGENIC_CHANNEL_PLUGIN` 指到本目录。

## 开发

```bash
npm install
npm test
```
