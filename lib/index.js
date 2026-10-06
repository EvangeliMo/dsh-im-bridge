/**
 * dsh-im-bridge —— 在微信 / QQ 官方机器人里遥控 DeepSeek Harness。
 *
 * 设计原则：
 *  1. **打开 DSH 即用**：通道在 apply() 里自动启动，不需要用户另开进程；
 *     QQ 走官方机器人 WebSocket，微信走官方 iLink 长轮询，都是进程内 HTTP/WS。
 *  2. **零依赖**：不用 SDK、不装 npm 包，只用 Node 内置 fetch / WebSocket。
 *  3. **出错不拖垮 Host**：任何通道失败都只记日志改状态，绝不抛进 DSH 启动流程；
 *     插件卸载或 DSH 退出时统一 stop()。
 *
 * 配置（写进 profile 的 cordis.patch.yml，见 README）：
 *   - id: dsh-im-bridge
 *     config:
 *       defaultCwd: D:\\some\\dir
 *       qq: { appId: "...", appSecret: "...", sandbox: false }
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createRouter, describeError } from './router.js'
import { createSessions } from './sessions.js'
import { createStore } from './store.js'
import { createQqChannel } from './channels/qq.js'
import { createWechatChannel } from './channels/wechat.js'
import { buildUserContent } from './media.js'
import { openExternal, writeQrPage } from './qr.js'

export const name = 'dsh-im-bridge'
export const inject = ['sessionController', 'sessionQuery']

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CRED_FILE = path.join(HOME, 'storages', 'im_bridge_creds.json')
const STATUS_FILE = path.join(HOME, 'storages', 'im_bridge_status.json')
const QR_FILE = path.join(HOME, 'storages', 'im_bridge_qr.txt')
/**
 * 绑定指南。插件自带一份 BINDING.md，启动时复制到 %DSH_HOME% 根目录 ——
 * 这样用户装完之后可以直接问自己的 Agent「怎么绑定微信/QQ」，
 * Agent 能在这个显眼位置找到答案（而不是要它去翻 node_modules）。
 */
const GUIDE_SRC = path.join(import.meta.dirname, '..', 'BINDING.md')
const GUIDE_FILE = path.join(HOME, 'IM_BRIDGE_BINDING.md')
/** 微信扫码页：本地渲染二维码（qrcode_img_content 只是二维码内容，不是图片地址）。 */
const QR_HTML = path.join(HOME, 'storages', 'im_bridge_qr.html')
const QR_PAGE_OPTIONS = {
  title: '用手机微信扫码绑定',
  hint: '手机微信 8.0.70+；入口：我 → 设置 → 插件',
}

function loadCreds() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveCreds(creds) {
  fs.mkdirSync(path.dirname(CRED_FILE), { recursive: true })
  const tmp = `${CRED_FILE}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(creds, null, 2), 'utf8')
  fs.renameSync(tmp, CRED_FILE)
}

/**
 * 把自带的绑定指南复制到 %DSH_HOME% 根目录（内容有变化才写）。
 * 目的是让"装完之后问 Agent 怎么绑定"这条路走得通：Agent 在 DSH 主目录下
 * 一眼就能看到 IM_BRIDGE_BINDING.md。
 */
function publishGuide(log) {
  try {
    const content = fs.readFileSync(GUIDE_SRC, 'utf8')
    const existing = fs.existsSync(GUIDE_FILE) ? fs.readFileSync(GUIDE_FILE, 'utf8') : null
    if (existing !== content) {
      fs.mkdirSync(path.dirname(GUIDE_FILE), { recursive: true })
      fs.writeFileSync(GUIDE_FILE, content, 'utf8')
    }
    return GUIDE_FILE
  } catch (error) {
    log?.warn?.(`发布绑定指南失败: ${error?.message ?? error}`)
    return null
  }
}

function makeLogger(ctx) {
  try {
    const logger = ctx.logger?.('dsh-im-bridge')
    if (logger?.info) return logger
  } catch {
    /* fall through */
  }
  const prefix = '[im-bridge]'
  return {
    info: (...args) => console.log(prefix, ...args),
    warn: (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
    debug: () => {},
  }
}

export function apply(ctx, config = {}) {
  const log = makeLogger(ctx)
  const store = createStore(log)
  const sessions = createSessions(ctx, log)
  // 入站附件：下载 → （必要时解密）→ 存成 Host 附件 → 组装 prompt content。
  const media = {
    build: ({ text, attachments, sessionId, forceFile }) =>
      buildUserContent({ ctx, log, text, attachments, sessionId, config, forceFile: !!forceFile }),
  }
  const router = createRouter({ sessions, store, log, config, media })

  /** @type {Map<string, {id:string, start:Function, stop:Function, sendText:Function, status:Function}>} */
  const channels = new Map()
  const channelStatus = new Map()

  const onStatus = (status) => {
    const previous = channelStatus.get(status.channelId)
    channelStatus.set(status.channelId, status)
    if (previous?.state === status.state && previous?.detail === status.detail) return
    // 命令结果在客户端里不显眼，所以状态同时落盘，方便随时查看与排错。
    try {
      fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true })
      fs.writeFileSync(
        STATUS_FILE,
        JSON.stringify({ updatedAt: new Date().toISOString(), channels: Object.fromEntries(channelStatus) }, null, 2),
        'utf8',
      )
    } catch {
      /* 状态文件只是便利设施，写不了不影响运行 */
    }
    if (status.channelId === 'wechat' && (status.state === 'polling' || status.state === 'idle')) {
      // 扫码成功了：把二维码文件改写成结论，避免下次误以为还没绑定。
      try {
        fs.writeFileSync(QR_FILE, `${new Date().toISOString()}\n微信已绑定成功（state=${status.state}），不需要再扫码。\n`, 'utf8')
      } catch {
        /* noop */
      }
    }
  }

  const onMessage = async (message) => {
    const channel = channels.get(message.channelId)
    const reply = async (text) => {
      if (!channel) return
      try {
        await channel.sendText(message.chatId, text)
      } catch (error) {
        log.warn?.(`[${message.channelId}] 发送失败: ${error?.message ?? error}`)
      }
    }
    // 文件走单独的出口：文本失败只记日志，文件失败必须让路由层知道并回告用户。
    reply.file = async (absPath, name) => {
      if (!channel) throw new Error('通道不可用')
      if (typeof channel.sendFile !== 'function') throw new Error(`${message.channelId} 通道不支持发送文件`)
      return await channel.sendFile(message.chatId, absPath, name)
    }
    try {
      await router.handle(message, reply)
    } catch (error) {
      log.error?.(`[${message.channelId}] 处理消息失败: ${error?.stack ?? error}`)
      await reply(`❌ 处理失败：${error?.message ?? error}`)
    }
  }

  // ------------------------------------------------------------------ 微信
  let credWriteTimer = null
  const persistWechat = (patch) => {
    // 长轮询每 ~35s 就送来一个新游标；合并写盘，避免刷爆磁盘。
    if (credWriteTimer) clearTimeout(credWriteTimer)
    credWriteTimer = setTimeout(() => {
      credWriteTimer = null
      try {
        const creds = loadCreds()
        creds.wechat = { ...(creds.wechat ?? {}), ...patch }
        saveCreds(creds)
      } catch (error) {
        log.warn?.(`凭据写入失败: ${error?.message ?? error}`)
      }
    }, 2000)
  }

  const wechatCredentials = loadCreds().wechat ?? {}

  const wechat = createWechatChannel({
    log,
    onMessage,
    onStatus,
    onSession: persistWechat,
    // 二维码自动换新时重写页面（页面自带 20s 刷新，所以浏览器里看到的总是最新的）。
    onQr: (url) => {
      try {
        writeQrPage(QR_HTML, url, QR_PAGE_OPTIONS)
        fs.writeFileSync(QR_FILE, `${new Date().toISOString()}\n${url}\n`, 'utf8')
      } catch (error) {
        log.warn?.(`二维码页面写入失败: ${error?.message ?? error}`)
      }
    },
    credentials: wechatCredentials,
  })
  channels.set('wechat', wechat)

  // ------------------------------------------------------------------ QQ
  // 凭据优先从 config 读；没配置时回落到凭据文件，便于避免把 AppSecret
  // 贴进对话（对话内容会写进会话日志）。
  const fileCreds = loadCreds()
  const qqConfig = { ...(fileCreds.qq ?? {}), ...(config.qq ?? {}) }
  if (qqConfig.appId && qqConfig.appSecret) {
    channels.set('qq', createQqChannel({
      appId: String(qqConfig.appId),
      appSecret: String(qqConfig.appSecret),
      sandbox: !!qqConfig.sandbox,
      log,
      onMessage,
      onStatus,
    }))
  } else {
    log.info?.('QQ 通道未配置（config.qq.appId / appSecret 缺失），跳过')
    channelStatus.set('qq', { channelId: 'qq', state: 'unconfigured' })
  }

  for (const channel of channels.values()) {
    Promise.resolve()
      .then(() => channel.start())
      .catch((error) => {
        log.warn?.(`[${channel.id}] 启动失败: ${error?.message ?? error}`)
        channelStatus.set(channel.id, { channelId: channel.id, state: 'error', detail: String(error?.message ?? error) })
      })
  }

  // ------------------------------------------------- DSH 里的运维命令 /im
  const commands = ctx.get('commands')
  let disposeCommand = null
  if (commands) {
    try {
      disposeCommand = commands.register({
        name: 'im',
        description: 'IM 桥接运维：查看通道状态、为微信扫码绑定、查看绑定指南、重启通道',
        input: { hint: 'status | qr | guide | restart' },
        async handler(invocation) {
          const [sub = 'status'] = String(invocation?.rawInput ?? '').trim().split(/\s+/)
          if (sub === 'status') {
            const lines = ['📡 dsh-im-bridge']
            for (const [id, channel] of channels) {
              const status = channel.status?.() ?? channelStatus.get(id) ?? { state: 'unknown' }
              lines.push(`  ${id}: ${status.state}${status.detail ? ` (${status.detail})` : ''}`)
            }
            if (channelStatus.has('qq') && !channels.has('qq')) lines.push('  qq: unconfigured（缺 config.qq.appId/appSecret）')
            lines.push(`  实时状态: ${STATUS_FILE}`)
            lines.push(`  凭据文件: ${CRED_FILE}`)
            lines.push(`  绑定指南: ${GUIDE_FILE}`)
            return { kind: 'success', text: lines.join('\n') }
          }
          if (sub === 'guide' || sub === '绑定' || sub === '帮助') {
            const path_ = publishGuide(log) ?? GUIDE_FILE
            return {
              kind: 'success',
              text: [
                '📖 绑定指南（完整版）：',
                path_,
                '',
                '速览：',
                '  微信 —— 在本对话里执行 /im qr，用手机微信「我 → 设置 → 插件」扫码。',
                '         不需要注册开发者，扫码即用（手机微信需 8.0.70+）。',
                '  QQ   —— 去 https://q.qq.com 创建机器人拿 AppID/AppSecret，',
                '         在后台开通单聊 intent（1<<25），用自己的 QQ 加机器人为好友，',
                `         然后写进 ${CRED_FILE}，再执行 /im restart。`,
                '         漏开 1<<25 的典型症状：连上立刻 close 1006，或永远收不到消息。',
                '',
                '验证：/im status 看到 wechat: polling / qq: online 即为成功。',
                '也可以把上面这个文件路径直接丢给你的 Agent，让它照着帮你做。',
              ].join('\n'),
            }
          }
          if (sub === 'qr') {
            if (wechat.bound) return { kind: 'success', text: '微信已绑定；如需重新绑定，删除凭据文件后重启 DSH。' }
            const url = await wechat.beginLogin()
            // onQr 回调通常已经把二维码页面写好并打开了；这里兜底一次。
            if (!fs.existsSync(QR_HTML)) writeQrPage(QR_HTML, url, QR_PAGE_OPTIONS)
            const opened = openExternal(QR_HTML)
            return {
              kind: 'success',
              text: [
                opened ? '📱 已打开扫码页面，请用手机微信扫描屏幕上的二维码。' : '📱 请打开下面的文件扫码：',
                QR_HTML,
                '',
                '（手机微信需 8.0.70+；入口：我 → 设置 → 插件）',
                '二维码约 2 分钟有效，过期会自动换新；页面每 20 秒自动刷新。',
                '扫码确认后再发一次 /im status 查看状态。',
              ].join('\n'),
            }
          }
          if (sub === 'restart') {
            for (const channel of channels.values()) {
              try {
                await channel.stop()
                await channel.start()
              } catch (error) {
                log.warn?.(`[${channel.id}] 重启失败: ${error?.message ?? error}`)
              }
            }
            return { kind: 'success', text: '🔄 已重启全部 IM 通道。' }
          }
          return { kind: 'error', text: `未知子命令「${sub}」。可用：status | qr | guide | restart` }
        },
      })
    } catch (error) {
      log.warn?.(`注册 /im 命令失败: ${error?.message ?? error}`)
    }
  }

  log.info?.(`已加载：通道 ${[...channels.keys()].join(', ') || '（无）'}`)
  // 把绑定指南放到 %DSH_HOME% 根目录，方便用户直接问自己的 Agent 怎么绑定。
  const guidePath = publishGuide(log)
  if (guidePath) log.info?.(`绑定指南已就绪: ${guidePath}`)

  return async () => {
    disposeCommand?.()
    if (credWriteTimer) {
      clearTimeout(credWriteTimer)
      credWriteTimer = null
    }
    await Promise.allSettled([...channels.values()].map((channel) => channel.stop()))
    await store.flush()
  }
}

export default { name, inject, apply }
