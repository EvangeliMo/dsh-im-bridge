# 通道协议备忘（已核实）

本文件固化两条官方机器人通道的接口细节，避免以后再花一次调研成本。
来源：`Tencent/openclaw-weixin` 官方仓库 `docs/protocol_zh_CN.md`、QQ 机器人开放平台官方文档
（`bot.q.qq.com/wiki`）、以及 `@tencent-connect/qqbot-nodejs` 包内源码。核实时间 2026-10-06。

> 本插件**不引入任何第三方依赖**，两个通道都用 Node 内置 `fetch` + 全局 `WebSocket` 手写。

---

## 一、微信 ClawBot / iLink（官方，MIT）

### 1.1 端点

| 用途 | 方法 | 路径 |
|---|---|---|
| 取二维码 | POST | `https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3` |
| 轮询扫码状态 | GET | `https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=<urlenc>[&verify_code=]` |
| 收消息（长轮询） | POST | `<baseurl>/ilink/bot/getupdates` |
| 发消息 | POST | `<baseurl>/ilink/bot/sendmessage` |
| 取上传地址 | POST | `<baseurl>/ilink/bot/getuploadurl` |
| 媒体上传 | POST | `https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=<urlenc>&filekey=<filekey>` |

### 1.2 绑定

```jsonc
// POST get_bot_qrcode  body: {"local_token_list": []}   // 最多 10 个本地 token
// -> {"qrcode": "...", "qrcode_img_content": "https://..."}   // 后者就是可直接渲染的二维码 URL

// GET get_qrcode_status?qrcode=<urlenc>   （35s 超时等价 wait，轮询间隔 1s）
// status: wait | scaned | confirmed | expired | need_verifycode
//       | verify_code_blocked | scaned_but_redirect | binded_redirect
//   scaned_but_redirect -> 带 redirect_host，需切到 https://<redirect_host> 继续
// confirmed -> {"bot_token", "ilink_bot_id", "baseurl", "ilink_user_id"}
```

注意：`confirmed` 返回的 `baseurl` 要作为后续收发消息的基址；二维码本身约 2 分钟有效。

### 1.3 请求头（除二维码阶段外每个请求都要带）

```
Authorization: Bearer <bot_token>
AuthorizationType: ilink_bot_token
X-WECHAT-UIN: <随机 uint32 的十进制字符串再 base64，每请求重新生成>
iLink-App-Id: bot
iLink-App-ClientVersion: <0x00MMNNPP 的十进制，如 2.4.9 -> 0x00020409 = 132105>
Content-Type: application/json
```

二维码阶段只带 `iLink-App-Id` / `iLink-App-ClientVersion`，**不带** Authorization。

### 1.4 收消息

```jsonc
// POST getupdates
{ "get_updates_buf": "", "base_info": {"channel_version": "2.4.8", "bot_agent": "OpenClaw"} }
// ->
{ "ret": 0, "msgs": [ /* WeixinMessage */ ], "get_updates_buf": "<下次原样回传>",
  "longpolling_timeout_ms": 35000 }
```

`get_updates_buf` 是**不透明游标**（不是 offset），首次传空串，之后必须持久化非空的返回值。

`WeixinMessage` 关键字段：`seq`、`message_id`（uint64，**必须无损转成字符串**）、
`from_user_id`、`to_user_id`、`client_id`、`create_time_ms`、`session_id`、`group_id`、
`message_type`（`1 = USER`，`2 = BOT`）、`message_state`（0 NEW / 1 GENERATING / 2 FINISH）、
`item_list[]`、`context_token`。

`item_list[].type`：`1` text（`.text_item.text`）、`2` image、`3` voice、`4` file（`.file_item.file_name/.len`）、
`5` video、`11`/`12` tool call。媒体引用是 `CDNMedia {encrypt_query_param, aes_key, encrypt_type, full_url}`。

`ret` 或 `errcode = -14` → token 失效（官方暂停该账号 1 小时），只能重新扫码；**没有刷新接口**。

### 1.5 发消息

```jsonc
// POST sendmessage
{
  "msg": {
    "from_user_id": "", "to_user_id": "<对方 uid>", "client_id": "<唯一串>",
    "message_type": 2, "message_state": 2,
    "context_token": "<入站消息原样回传，会话路由锚点，实质必填>",
    "item_list": [{ "type": 1, "text_item": { "text": "你好" } }]
  },
  "base_info": { "channel_version": "2.4.8", "bot_agent": "OpenClaw" }
}
```

回复某条消息靠 `context_token`，**不是** `message_id`。文本上限协议未下发，社区按 **2000 字符**保守分片。

### 1.6 边界

- 入口：微信 **8.0.70+**，「我 → 设置 → 插件」，无需审核，但腾讯**逐步放量**（部分账号看不到）。
- 必通域名：`ilinkai.weixin.qq.com`、`novac2c.cdn.weixin.qq.com`。
- **实质只支持私聊**：拿到的是 `...@im.bot` 身份，普通微信群拉不进、iLink 不投递普通群事件。
- **同一 token 只能单实例**，多实例互抢会话并触发 `-14`。

---

## 二、QQ 官方机器人

### 2.1 凭据

```jsonc
// POST https://api.bot.qq.com/app/getAppAccessToken
{ "appId": "...", "clientSecret": "..." }
// -> {"access_token": "...", "expires_in": "7200"}   // expires_in 是字符串
```

失败时 **HTTP 仍是 200**，必须判 `code`（`100007` appid 无效 / `100016` appid 或 secret 无效 /
`10004` 机器人不存在）。有效期内重复获取返回同一个 token，过期前 60s 内才发新值。

调用头：`Authorization: QQBot <ACCESS_TOKEN>`，REST 基址 `https://api.bot.qq.com`。

### 2.2 WebSocket 网关

```
GET /gateway   Authorization: QQBot <AT>   ->  {"url": "wss://api.bot.qq.com/websocket/"}
```

| op | 含义 |
|---|---|
| 0 | Dispatch（事件） |
| 1 | Heartbeat |
| 2 | Identify |
| 6 | Resume |
| 7 | Reconnect |
| 9 | Invalid Session |
| 10 | Hello（带 `heartbeat_interval`，通常 45000） |
| 11 | Heartbeat ACK |

```
IDENTIFY  {"op":2,"d":{"token":"QQBot <AT>","intents":<mask>,"shard":[0,1],"properties":{}}}
HEARTBEAT {"op":1,"d":<最新 s，首次 null>}          // 收到 {"op":11} 为 ACK
RESUME    {"op":6,"d":{"token":"QQBot <AT>","session_id":"...","seq":<s>}}
```

**⚠️ 私聊 intent 是 `GROUP_AND_C2C_EVENT = 1 << 25`**（不是 `DIRECT_MESSAGE`），
且该权限位**需要在开放平台单独申请**；订阅了无权限的 intent 会直接被断开（4914/4014）。

致命关闭码：`4914`（机器人已下架，只允许连沙箱）、`4915`（机器人已封禁）——不重连。

### 2.3 收消息

事件 `C2C_MESSAGE_CREATE`：

```
id                       // 事件 id，被动回复必须回填为 msg_id
content                  // 文本
timestamp
author.user_openid       // 回复目标
attachments[]            // {url, filename, size, content_type, ...}
```

**入站媒体（2026-10-07 真机核实）**

```
attachments[] = { url, filename, size, content_type, width, height }

url 形如  https://multimedia.nt.qq.com.cn/download?appid=1406&fileid=EhQ...
        → 直接 GET 即可，**不需要额外资权头，也没有加密**
filename  形如  BDF97D9DDDFFAC8C07701DD48F1F7BF5.png   （32 位大写十六进制）
```

实测拿到的那张：`filename` 是 `.png`，但**真实字节是 JPEG**（`ff d8 ff e0`）。

⚠️ **永远按魔数判类型，不要信 `filename` 或 `content_type`。** 两条通道都有这个坑
（微信用 `media-<id>.jpg` 装一切；QQ 的扩展名也不可靠）。

### 2.4 发消息

```
POST /v2/users/{user_openid}/messages      Authorization: QQBot <AT>

被动回复: {"content":"你好","msg_type":0,"msg_id":"<事件 id>","msg_seq":1}
主动推送: {"content":"在吗","msg_type":0}                  // 无 msg_id
富媒体:   {"msg_type":7,"media":{"file_info":"..."},"msg_id":"...","msg_seq":1}
```

- `msg_type`：`0` 文本 / `2` Markdown / `6` 输入中 / `7` 富媒体。
- **`msg_id + msg_seq` 组合重复会被去重失败**（40054005）；同一个 `msg_id` 多次回复要递增 `msg_seq`。
- **被动回复窗口：单聊 60 分钟 / 最多 4 次**（群聊才是 5 分钟 / 5 次）。超窗口只能走主动推送，
  而用户可以在资料卡关闭「允许主动发送」。
- 主动推送频控：认证主体 10 qps + 单关系 20 qpm；未认证 5 qps / 30 qpm；单好友每天上限 1000 条。
- 文件两步：先上传拿 `file_info`，再 `msg_type: 7` 发送。**单聊与群聊上传接口不互通**，详见 §2.6。
- 大小上限：**软限制** 图片 20MB / 视频 30MB / 语音 20MB / 文件 200MB，**硬限制统一 200MB**
  （超软限降级为文件类型上传，超硬限报错 `850031`）。

### 2.6 单聊富媒体上传（已从官方文档核实）

**只有两种上传方式，没有 base64 直传**，所以本地文件必须走分片合并：

```
① POST /v2/users/{openid}/upload_prepare          频率 10 QPS
   { file_type, file_size:"<字节>", file_name, md5, sha1, md5_10m }
   md5_10m = 文件前 10002432 字节的 MD5
   -> { upload_id, block_size:"<字节>", parts:[{index, presigned_url, block_size}],
        upload_config:{concurrency, retry_timeout, retry_delay} }

② 对每个 part：HTTP PUT <presigned_url>，body = 该分片字节
   成功后 POST /v2/users/{openid}/upload_part_finish
   { upload_id, part_index, block_size:"<该片长度>", md5:"<该片 MD5>" }   -> {}

   ⚠️ **`parts[].index` 是 1 基的**（文档写"从 0 开始"，实测返回 1）。
   绝不能拿 `index * block_size` 当切片偏移 —— 单分片传小文件时会切出**空缓冲区**，
   PUT 0 字节，CDN 上存的是空对象（ETag = d41d8cd9…，空内容的 MD5），
   然后 `upload_part_finish` 报 **40093001「分片转存异常，请重试」** ——
   看文案像是偶发，其实重试一万次也没用。
   正确做法：按 index 排序后用**累计偏移**依次切片；并校验
   ETag == 所发内容的 MD5（这一条单独就能抓住此问题）。

③ POST /v2/users/{openid}/files
   { file_type, srv_send_msg:false, file_name, upload_id }
   -> { file_uuid, file_info, ttl }        // file_info 直接透传，无需解析

④ POST /v2/users/{openid}/messages
   { msg_type:7, media:{ file_info }, msg_id, msg_seq }   // 富媒体同样吃被动回复预算
```

`file_type`：`1` 图片(png/jpg) / `2` 视频(mp4) / `3` 语音(silk) / `4` 文件。
另有 URL 直传形式（`{file_type, url, srv_send_msg}`，要求 `url` 以 http 开头，平台自行下载转存），
本地文件用不上。
- 大小上限官方文档与 SDK 常量不一致（官方 200MB 硬限 / SDK 100MB 常量），以真机实测为准。

### 2.5 前提与风控

- 个人主体可注册机器人（最多 5 个），需主体认证；**未认证时机器人只有管理员可用**。
- **私聊需要先建立好友关系**，否则报 `40054004 无好友关系`。
- 错误码：`40054013` 用户拒收、`40054018` 消息过长、`1100101` 内容敏感、`40034100` 主动消息超限。
