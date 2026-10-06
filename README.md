# dsh-im-bridge

在**微信 / QQ 官方机器人**的私聊里遥控 DeepSeek Harness。

打开 DeepSeek Harness 就能用：通道在插件 `apply()` 里自动启动，**不需要手动开任何进程**，
不注入、不 Hook、不冻结客户端版本、不改微信。两个通道都是进程内 HTTP / WebSocket。

```
手机微信/QQ ──私聊──▶ 官方机器人 ──(iLink 长轮询 | QQ WebSocket)──▶ 本插件 ──▶ Harness 会话
```

> ### 📖 想绑定微信 / QQ？看 [BINDING.md](BINDING.md)
>
> 安装后这份指南会被复制到 `%DSH_HOME%\IM_BRIDGE_BINDING.md`。
> **你可以直接问自己的 Agent**「怎么绑定微信/QQ」，让它读那个文件照着帮你做；
> 在 DSH 里执行 `/im guide` 也能拿到同样的速览。
>
> 一句话版：**微信**执行 `/im qr` 用手机微信「我 → 设置 → 插件」扫码即可（无需注册）；
> **QQ** 要去 [q.qq.com](https://q.qq.com) 申请机器人，且**必须开通 `1<<25` 单聊 intent**。

---

## 一、安装

当前 DSH 桌面版的全局 `dsh` 命令不可靠（本机实测会报
`Cannot find module ...@deepseek-ai\dsh\lib\bin.js`），所以走仓库里的安装脚本：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File <你克隆到的路径>\scripts\install.ps1
```

脚本做的事（幂等，每次先备份）：

1. 把插件以**真实目录**拷进 `%DSH_HOME%\profiles\desktop\node_modules\dsh-im-bridge`
   —— 不用 junction，因为 app 的恢复流程会顺着 junction 删掉源目录（开发者曾因此丢过源码）；
2. 把 `dsh-im-bridge` 加进 profile `package.json` 的 `dependencies` 与 `dsh.profile.bundles`
   —— **只有进了 bundles 才会被组合进 `cordis.yml`**，光有依赖不会加载；
3. 用**无 BOM** 的 UTF-8 写回 manifest —— `dsh-host` 用裸 `JSON.parse()` 读它，
   带 BOM 会在启动时抛 `Unexpected token '\uFEFF'` 并崩溃；
4. 把绑定指南复制到 `%DSH_HOME%\IM_BRIDGE_BINDING.md`。

然后**重启 DeepSeek Harness**，在任意会话里发 `/im status` 验证。

> 改宿主代码（`lib/*.js`）需要重启 DSH；本插件没有客户端半边，不涉及浏览器 bundle 重建。
> 改完源码后重跑一次 install.ps1 即可同步部署副本。

---

## 二、配置

### 2.1 QQ 官方机器人（推荐先做通）

五步，全部在浏览器 + QQ 客户端里完成：

| 步 | 做什么 |
|---|---|
| 1 | 打开 <https://bot.q.qq.com/>，用手机 QQ 扫码登录开放平台 |
| 2 | 创建/进入你的机器人 → 「开发设置」页，复制 **AppID** 和 **AppSecret** |
| 3 | 在事件订阅 / 功能配置里**申请「单聊消息」相关事件权限**（后端 intent 位是 `1 << 25`） |
| 4 | 用你自己的 QQ **搜索并添加这个机器人为好友**（不建立好友关系无法私聊它） |
| 5 | 把 AppID / AppSecret 填进 `%DSH_HOME%\storages\im_bridge_creds.json`（见下），重启 DSH |

```jsonc
// %DSH_HOME%\storages\im_bridge_creds.json
// Windows 默认位置：%USERPROFILE%\.dsh\storages\im_bridge_creds.json
{ "qq": { "appId": "你的AppID", "appSecret": "你的AppSecret", "sandbox": false } }
```

也可以写进 profile 的 `cordis.patch.yml`（`%DSH_HOME%\profiles\desktop\cordis.patch.yml`），
`config.qq` 优先级更高：

```yaml
- id: dsh-im-bridge
  name: dsh-im-bridge
  config:
    qq:
      appId: "你的AppID"
      appSecret: "你的AppSecret"
      sandbox: false
```

> 推荐用 JSON 文件——把 AppSecret 贴在对话里会被写进 Harness 的会话日志。

**两个前提，缺一会连不上**：

1. **必须申请 `C2C_MESSAGE_CREATE` 对应的事件权限**（`GROUP_AND_C2C_EVENT = 1 << 25`）。
   开放平台默认只给 `GUILDS` / `PUBLIC_GUILD_MESSAGES` / `GUILD_MEMBERS`；
   订阅了没有权限的 intent，WebSocket 会被**直接断开**（4914 / 4014），日志里能看到。
2. **你的 QQ 号要先和机器人建立好友关系**，否则发消息会报 `40054004 无好友关系`。

> **不想改 YAML 的话**：把凭据写进 `%DSH_HOME%\storages\im_bridge_creds.json` 也可以，
> `config.qq` 优先级更高：
>
> ```json
> { "qq": { "appId": "你的AppID", "appSecret": "你的AppSecret", "sandbox": false } }
> ```
>
> 推荐这种方式——把 AppSecret 贴在对话里会被写进 Harness 的会话日志。

### 2.2 微信 ClawBot / iLink

微信 8.0.70+，先确认「我 → 设置 → 插件」里能看到机器人入口（腾讯逐步放量，看不到就是没被灰度到）。
然后在 DSH 任意会话里：

```
/im qr
```

插件会**在本地生成二维码**，写成一个自包含的 HTML 页面（`%DSH_HOME%\storages\im_bridge_qr.html`）
并用浏览器打开 —— 用手机微信扫屏幕上的二维码即可。

> ⚠️ 协议里 `qrcode_img_content` 返回的**不是图片地址**，而是一段
> `https://liteapp.weixin.qq.com/q/...` 的 HTML 链接，它是要**被编码进二维码的内容**。
> 直接把这个链接丢给浏览器打开是错的（手机扫不到二维码）。所以本插件内置了
> `vendor/qrcode-generator.cjs`（单文件、MIT、零依赖）来本地渲染。

> **只需要扫一次。** 绑定成功后 `bot_token` + `baseurl` + 游标一起写进
> `%DSH_HOME%\storages\im_bridge_creds.json`，之后每次打开 DSH 都是直接读文件进入长轮询，
> 不会再要二维码。只有两种情况需要重新扫：
> ① 删掉了凭据文件；② token 失效（`ret = -14`，官方还会暂停该账号 1 小时，且**没有刷新接口**）。

二维码约 **2 分钟**有效，所以在它过期时插件会**自动重新取码**，页面每 20 秒自刷新 ——
什么时候扫都拿到当前有效的那张。

每次 `/im qr` 成功后可以再发一次 `/im status` 看状态；状态也会实时写入
`%DSH_HOME%\storages\im_bridge_status.json`，客户端里看不到命令结果时直接看这个文件。

### 2.3 其他配置（都可省略）

```yaml
- id: dsh-im-bridge
  name: dsh-im-bridge
  config:
    defaultCwd: <未绑定时新建会话的工作区绝对路径>
    includeBlank: false                      # 会话列表是否包含空白会话
    replyTimeoutMs: 900000                   # 等待模型回答的超时（毫秒）
```

---

## 三、聊天里能用的指令

| 指令 | 作用 |
|---|---|
| `/会话列表` `/ls` | 按工作区分组列出会话，编号形如 `1.2`（每区默认只显示最近 15 条） |
| `/会话列表 <工作区名>` | 只看某个工作区的全部会话（最多 60 条） |
| `/工作区` | 列出工作区（编号 + 路径），给 `/新建` 用 |
| `/归位` | 把落在"未分组"、但 cwd 属于某个工作区的会话补挂回去 |
| `/模式` | 列出可选模式（Agent Preset），标出 Host 默认与本聊天已选 |
| `/模式 2` / `/模式 <id>` | 选定模式，对**之后新建**的会话生效 |
| `/模式 默认` | 恢复跟随 Host 默认模式 |
| `/新建 <工作区> <模式>` | 一次到位，例如 `/新建 Harness minimal` |
| `1.2` | 直接回复编号进入该会话（回显工作区/标题/模型/最近 5 条） |
| `/进入 1.2` | 同上，显式写法 |
| `/当前` | 当前绑定的会话 |
| `/历史 [n]` | 最近 n 条（默认 10） |
| `/模型` → `/模型 2` | 列出模型 / 按编号或 `provider/model` 切换 |
| `/思考` → `/思考 high` | 列出 / 切换思考强度（`/思考 默认` 恢复） |
| `/产物` | 列出本会话产出的文件（模型交付声明 + 写文件类工具） |
| `/产物 2` | 把第 2 个文件发到当前聊天 |
| `/发文件 <路径>` | 直接发送一个文件（相对路径按工作区解析） |
| `/停止` | 中断当前回合 |
| `/新建 <工作区名或编号>` | 新建会话并进入，例如 `/新建 Harness` |
| `/退出` | 解除绑定 |
| `/详细 on\|off` | 是否显示工具调用明细 |
| `/状态` | 桥接运行状态 |
| `/问 <文本>` | 强制把文本原样发给会话（用于纯数字等会被当成编号的输入） |
| 直接发一句话 | 发给当前会话；未绑定时自动新建 |

> 指令解析对手机输入法做了容错：**全角空格（U+3000）、零宽字符、缺分隔符**
> （`/新建Harness`、`/新建　Harness`）都能正确识别。

DSH 界面里的运维命令：`/im status`、`/im qr`、`/im restart`。

---

## 四、开发与验证

两个冒烟测试**都不需要 DSH、不需要网络、不需要账号**：

```powershell
# 入口级：直接调用 apply(ctx)，验证装配、/im 命令注册与 disposer 收尾
node scripts/test-apply.mjs

# 指令流：用假的 sessionController/sessionQuery/workspaceRegistry 跑完整对话链路
node scripts/test-host.mjs
```

`test-host.mjs` 覆盖：会话列表按工作区分组与编号、编号进入、提问与回答、模型切换、
思考强度、历史、退出、越界编号拒绝、子代理与空白会话过滤。

装完之后建议直接对**部署副本**再跑一遍，验证 DSH 将要加载的就是通过测试的那份：

```powershell
Set-Location $env:DSH_HOME\profiles\desktop\node_modules\dsh-im-bridge
node scripts/test-apply.mjs
node scripts/test-host.mjs
```

### QQ 通道联调（需要真实凭据，独立于 DSH）

连不上 QQ 时不要猜，用这个脚本逐步定位：

```powershell
# 只验证 token → 网关 → WebSocket → intent 权限，看到 READY 就说明权限没问题
node scripts/test-qq-live.mjs --seconds 20

# 连上后一直监听，收到单聊消息就自动原样回复（验证完整往返）
node scripts/test-qq-live.mjs --seconds 300 --echo

# 机器人还没上线（close 4914）时试沙箱
node scripts/test-qq-live.mjs --sandbox --seconds 20
```

脚本会翻译关闭码：`4014` = 缺 intent 权限、`4914` = 机器人未上线、`4901`+ = 需要重连等。

> ⚠️ **同一个 bot token 只能维持一个 WebSocket 连接。** 跑这个脚本前先别让 DSH 里的插件连上
> （或先 disable 插件），否则两边会互抢连接。

### 微信通道联调（独立于 DSH）

```powershell
# 取二维码 → 本地渲染成扫码页并打开浏览器 → 轮询到 confirmed → 写凭据 → 收消息并回声
node scripts/test-wechat-live.mjs --seconds 900

# 只做绑定，不进入监听
node scripts/test-wechat-live.mjs --login-only
```

扫码状态会逐步打印：`wait → scaned → confirmed`，过期会自动换新。

> ⚠️ 同一个 `bot_token` 也只能有一个长轮询实例：跑这个脚本时不要同时让 DSH 里的插件在轮询。
> 脚本会把拿到的 token 写回凭据文件，所以**停掉脚本后重启 DSH 即可无缝接管**。

### 产物 / 附件

`/产物` 的文件来自两类会话事件：`deliverables/presented`（模型显式声明的交付）与写文件类工具的
`tool/call`。收集逻辑在 `lib/artifacts.js`，只允许发送工作区内的文件。

目录：

```
lib/index.js              插件入口：装配 store / sessions / router / channels，注册 /im 命令
lib/sessions.js           对 Host Service 的唯一适配层（升级 DSH 只改这里）
lib/router.js             指令解析与分发（纯逻辑，可测）
lib/render.js             聊天友好渲染 + 900 字分片
lib/store.js              每聊天的绑定与编号状态（原子写盘）
lib/artifacts.js          会话产物收集（交付声明 + 写文件工具）与工作区包含判定
lib/qr.js                 本地渲染二维码（扫码页 HTML）
lib/channels/qq.js        QQ 官方机器人：token → gateway → WebSocket → REST → 分片上传
lib/channels/wechat.js    微信 iLink：扫码绑定 → getupdates 长轮询 → sendmessage → CDN 上传
vendor/qrcode-generator.cjs  内置的二维码生成库（单文件、MIT、零依赖）
docs/PROTOCOL.md          两条通道的协议备忘（已核实的端点与踩坑）
scripts/install.ps1       部署到 desktop profile（真实目录拷贝、无 BOM manifest）
scripts/test-apply.mjs    入口级冒烟：apply(ctx) + /im 命令 + disposer
scripts/test-host.mjs     指令流冒烟：假 Host 服务跑完整对话
scripts/test-media.mjs    入站附件：协议解析 / 下载 / AES 解密 / 降级
scripts/test-qq-upload.mjs  QQ 富媒体上传：stub fetch 跑通分片与重试
scripts/test-wechat-upload.mjs  微信出站文件：aes_key 形态 + 回读自检
scripts/test-qq-live.mjs      QQ 真实联调：token → 网关 → WS → intent → 收发
scripts/test-wechat-live.mjs  微信真实联调：二维码 → 扫码 → 长轮询 → 收发
```

**五个**离线测试可以用一条命令跑完（都不需要 DSH / 网络 / 账号）：

```powershell
npm test
```

---

## 五、已知限制 / 待办

- **两条通道都已实测跑通**（2026-10-06，用真实账号、且用的是插件自身的通道代码）：
  - QQ：token / gateway / WebSocket IDENTIFY / `1<<25` intent → 收到手机消息 → 被动回复成功；
    期间还真实遇到一次 `close 1006`，自动重连回到了 `online`。
  - 微信：本地二维码 → 手机扫码 `confirmed` → 拿到 `bot_token`（`...@im.bot`）→ 长轮询收到
    「你好」→ `sendmessage` 回复成功，游标写回凭据文件。
- **入站附件（图片/文件）已实现但未真机验证**：QQ 用事件自带的 `attachments[].url` 下载；
  微信用 `CDNMedia.full_url` 或 `/c2c/download` 下载，并按 `aes_key` 做 AES-128-ECB 解密。
  图片走 `attachments.saveImage`，没过校验（体积/像素/格式）自动降级成文件附件；
  任何一步失败都退化成纯文本 + 一句提示，**正文不会丢**。
  离线测试覆盖了协议解析、解密往返、降级与失败路径。
- **方向性发送（`/产物`、`/发文件`）只有离线 stub 测试**：QQ 分片上传（`upload_prepare` → PUT
  → `upload_part_finish` → `/files` 合并 → `msg_type:7`）已加上分片重试 + 整轮重试 + 完整诊断；
  微信 CDN 上传（`getuploadurl` → AES-128-ECB/PKCS#7 → CDN → `x-encrypted-param`）仍是首次实现。
  微信 `file_item` 的字段嵌套（`{file_name, len, media}`）置信度最低，首次实测时优先看这里。
- **发送范围受限**：只允许发送工作区目录内的文件（`/发文件` 的越界请求会被拒绝），
  可用 `config.allowAnyPath` 放开；单文件默认上限 20MB（`config.maxFileBytes`）。
  入站附件默认上限 20MB / 30s 超时（`config.maxAttachmentBytes`、`config.attachmentTimeoutMs`）。
- **QQ 被动回复预算**：单聊 60 分钟 / 最多 4 次。一条长回答若被切成 4 片以上，
  超出的部分会退化为**主动推送**（需要用户在机器人资料卡开启「允许主动发送」）。
- **微信只能私聊**：拿到的是 `...@im.bot` 身份，拉不进普通群，iLink 也不投递群事件。
- **微信 token 单实例**：同一个 token 不能跑两个插件实例，会互抢会话并触发 `-14`。
- **QQ intent 权限**：`1 << 25` 必须在开放平台单独申请，这是最常见的"连上就掉"原因。
- **入站只处理文本**；图片 / 语音 / 文件入站暂未解析为 Harness 附件。

## 六、排错

**客户端里看不到 `/im status` 的结果？** 这是已知现象——自定义命令的结果在客户端里是一个小号的
命令结果块，不显眼。直接看这两个文件更可靠：

| 文件 | 内容 |
|---|---|
| `%DSH_HOME%\storages\im_bridge_status.json` | 两条通道的实时状态（每次状态变化就写） |
| `%DSH_HOME%\storages\im_bridge_qr.txt` | 最近一次的微信扫码链接；绑定成功后会被改写成"已绑定" |
| `%DSH_HOME%\storages\im_bridge_qr.html` | 本地渲染的扫码页（每 20 秒自动刷新） |
| `%DSH_HOME%\storages\im_bridge_media.log` | **每个入站附件一行**：HTTP 状态、原始字节数与头部、解密是否成功、判定的图片类型、失败原因 |

**附件出问题先看 `im_bridge_media.log`** —— 它能把「下载失败 / 拿到的是密文 / 解密失败 / 图片格式不认」这四种情况区分开。

也可以直接查会话日志里的 `command/done` 事件——命令一定执行了，结果一定被记录了。

### 已经踩过并修掉的坑（都带回归测试）

| 现象 | 根因 | 回归测试 |
|---|---|---|
| `未知指令「新建 Harness」` | 手机输入法给的是**全角空格/零宽字符**，解析器只按普通空格切 | 覆盖全角空格、零宽字符、无分隔符三种写法 |
| `session header cwd must be an absolute path, got "Harness"` | `/新建` 只认工作区编号，把名字原样当路径；且未校验相对路径 | 覆盖"按工作区名新建"与"相对 cwd 被拦住" |
| `Cannot read properties of undefined (reading 'throwIfAborted')` | `sessionController.prompt(request, **signal**)` 的 signal 是**必填**的，漏传 | mock 改为**严格模式**：漏传 signal 就抛同样的错（已验证撤掉修复即失败） |
| `/im status`、`/im qr` 的结果"看不见" | 自定义命令结果是命令块、不显眼 | 状态实时写 `im_bridge_status.json`；`/im qr` 直接开浏览器并写 `im_bridge_qr.txt` |
| 新建的会话掉进**未分组** | `create({ cwd })` 只写会话头的 cwd；工作区分组用 `Workspace.sessionIds`（= 已 attach ∩ cwd 匹配），必须再调 `attachSession` | 断言 `attachSession` 被调用（已验证撤掉修复即失败）；另加 `/归位` 抢救历史遗留会话 |
| `❌ 处理失败：media is not defined` | 一次编辑没生效（工具报 "file has not been read"），`createRouter` 少了 `media` 参数，但函数体已在用它 | 新增「带附件走一遍 router」的断言（已验证撤掉参数即复现同样报错） |
| `❌ 处理失败：File was not uploaded for this session.` | Host 的 `prompt` 里 **file part 必须是 `{type:'file', receiptId}`**（由 `fileUploads.uploadStream()` 暂存后发放），不能直接塞 `{type:'file', attachment}` | 断言文件走 `fileUploads` 并带 `receiptId`；另加"被拒时降级重发"的用例 |
| `❌ 处理失败：prompt rejected` | Host 在 `admitPromptContent` 里把 image part 当成**待保存的编码图片**再存一次（读 `part.data` / `part.mediaType`）。我传的是已存好的 `{type:'image', attachment}`，没有 `data`，异常被 Host 的兜底 catch 统一成了 `prompt rejected` | 断言图片以 `{type:'image', mediaType, data:<base64>}` 进 prompt；并把 `reason`/`code` 从兜底错误里翻出来显示 |
| 微信图片死活不是图片 | `CDNMedia.full_url` 给的是 **AES 密文**；且 `aes_key` 是 `base64(hex32)` 这种非常规形态 | 按魔数判类型（不信文件名）+ 三种 key 形态逐个试 + `im_bridge_media.log` 记录全过程 |
| 微信"发送成功"但提示**下载失败** | 出站 `aes_key` 发的是 `base64(16 原始字节)`，而服务端约定是 `base64(32 个 ASCII hex 字符)`（入站收到的正是这个形态） | 出站对齐同款形态；再加**回读自检**（上传后自己下载回来解密核对），解不开就报错而不是发一个注定打不开的文件 |
| 微信扫码后手机显示"网络错误" | `qrcode_img_content` 是**要被编码进二维码的链接**，不是图片地址 | 内置 `qrcode-generator` 本地渲染 + 过期自动换新 + 页面自刷新 |
| `/产物` 报 `40093001` | 两件事叠加：① 错误里只有 trace_id，无法区分"没传上去"和"服务端转存失败"；② **真机根因**是 `upload_prepare` 返回的 `part.index` **从 1 开始**，而我按 `index × block_size` 算偏移 → 小文件被切出**空缓冲区** → PUT 0 字节 → CDN 上存的是空对象（ETag = `d41d8cd9…`，空内容的 MD5）→ 服务端报"分片转存异常" | 加诊断（每片 PUT 状态 + ETag + 字节数）后一次定位；改为**按排序后的累计偏移**切片，并校验 ETag == 所发内容 MD5、防 0 字节分片、校验分片覆盖整个文件 |

**改完宿主代码必须重启 DSH**：`hmr.root` 是空的，DSH 不会热重载插件目录。

| 症状 | 原因 |
|---|---|
| QQ 连上就掉，close 4914 | intent 权限没批 / 机器人未上线 → 先用 `sandbox: true` |
| QQ 发消息报 `40054004` | 你和机器人还没有好友关系，先在 QQ 里加它 |
| QQ 报 `40054005` | 同一个 `msg_id` 复用了 `msg_seq`（插件已自增，出现说明被动回复已超 4 次） |
| 微信 `ret = -14` | token 失效（或另一实例在抢），删凭据文件重新 `/im qr` |
| 微信扫码后没反应 | 账号没被灰度到机器人功能；或 `ilinkai.weixin.qq.com` 不通 |
| `/im status` 里 qq 是 unconfigured | 没填 `config.qq.appId / appSecret` |
| 某个编号进不去 | 会话列表变了，重新发 `/会话列表` 刷新编号 |
