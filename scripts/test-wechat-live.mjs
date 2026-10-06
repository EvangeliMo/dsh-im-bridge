/**
 * 微信 iLink 通道真实联调（用**插件自己的通道代码**）。
 *
 *   node scripts/test-wechat-live.mjs [--seconds 300] [--no-open]
 *
 * 流程：
 *   1. 读 %DSH_HOME%\storages\im_bridge_creds.json 的 wechat 段；没绑过就取二维码并打开浏览器
 *   2. 轮询扫码状态：wait → scaned → confirmed，全程打印状态
 *   3. confirmed 后把 bot_token / baseurl / 游标写回凭据文件（DSH 重启后直接复用）
 *   4. 之后监听私聊消息并原样回复，验证完整往返
 *
 * ⚠️ 同一个 token 只能有一个长轮询实例：跑这个脚本时不要同时让 DSH 里的插件在轮询。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createWechatChannel } from '../lib/channels/wechat.js'
import { openExternal, writeQrPage } from '../lib/qr.js'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const has = (name) => args.includes(`--${name}`)

const SECONDS = Number(flag('seconds', 300))
const NO_OPEN = has('no-open')
const LOGIN_ONLY = has('login-only')

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CRED_FILE = path.join(HOME, 'storages', 'im_bridge_creds.json')

function loadCreds() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveWechat(patch) {
  const creds = loadCreds()
  creds.wechat = { ...(creds.wechat ?? {}), ...patch }
  fs.mkdirSync(path.dirname(CRED_FILE), { recursive: true })
  const tmp = `${CRED_FILE}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(creds, null, 2), 'utf8')
  fs.renameSync(tmp, CRED_FILE)
}

function openQrPage(url) {
  const file = path.join(HOME, 'storages', 'im_bridge_qr.html')
  writeQrPage(file, url, {
    title: '用手机微信扫码绑定',
    hint: '手机微信 8.0.70+；入口：我 → 设置 → 插件',
  })
  return file
}

const creds = loadCreds()
const saved = creds.wechat ?? {}
console.log(`凭据来源: ${CRED_FILE}`)
console.log(`已有 bot_token: ${saved.botToken ? `是（长度 ${saved.botToken.length}）` : '否'}  baseUrl: ${saved.baseUrl ?? '(默认)'}`)
console.log(`观察 ${SECONDS}s\n`)

let bound = !!saved.botToken
let received = 0
let replied = 0
let loginResolve
const loginDone = new Promise((resolve) => { loginResolve = resolve })

const channel = createWechatChannel({
  log: {
    info: (m) => console.log(`  [log] ${m}`),
    warn: (m) => console.log(`  [warn] ${m}`),
    error: (m) => console.log(`  [error] ${m}`),
  },
  credentials: saved,
  onStatus: (status) => {
    console.log(`  [status] ${status.state}${status.detail ? ` (${status.detail})` : ''}`)
    if (status.state === 'polling') {
      bound = true
      loginResolve?.('ok')
    }
    if (status.state === 'need-login' && status.detail && status.detail !== undefined) loginResolve?.('failed')
  },
  onLoginStatus: (state) => {
    const hint = {
      wait: '等待扫码…',
      scaned: '已扫码，请在手机上确认',
      confirmed: '确认成功，正在换取 token',
      expired: '二维码过期',
      need_verifycode: '需要输入验证码',
      verify_code_blocked: '验证码被拦截',
    }[state] ?? state
    console.log(`  [扫码] ${state} — ${hint}`)
  },
  onQr: (url) => {
    // qrcode_img_content 是要编码进二维码的链接，不是图片地址。
    const file = openQrPage(url)
    console.log(`  [二维码] 已写入 ${file}`)
    if (!NO_OPEN) openExternal(file)
  },
  onSession: (patch) => {
    saveWechat(patch)
    if (patch.botToken) console.log(`  [凭据] bot_token 已写入 ${CRED_FILE}`)
    if (patch.getUpdatesBuf) process.stdout.write('.') // 游标持续更新，打个点表示活着
  },
  onMessage: async (message) => {
    received += 1
    console.log(`\n  📨 收到私聊消息: "${message.text}"  chatId=${message.chatId}`)
    try {
      await channel.sendText(message.chatId, `插件通道回声：${message.text}`)
      replied += 1
      console.log(`  ✅ 已回复（第 ${replied} 次）`)
    } catch (error) {
      console.log(`  ❌ 回复失败: ${error?.message ?? error}`)
    }
  },
})

await channel.start()

if (!bound) {
  console.log('\n未绑定，获取二维码…')
  try {
    const url = await channel.beginLogin()
    console.log(`\n📱 扫码页面已生成并尝试打开浏览器。\n   页面里的二维码编码的是：${url}\n`)
    console.log('请用手机微信扫码确认（微信 8.0.70+，入口：我 → 设置 → 插件）')
    console.log('二维码约 2 分钟有效，过期会自动换新，页面每 20 秒自动刷新。\n')
  } catch (error) {
    console.error(`❌ 取二维码失败: ${error?.message ?? error}`)
    process.exit(1)
  }
} else {
  console.log('已有 token，直接进入长轮询\n')
}

if (LOGIN_ONLY) {
  const outcome = await Promise.race([
    loginDone,
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 180_000)),
  ])
  await channel.stop()
  console.log(`\n=== 结果 ===\n  绑定: ${outcome}`)
  process.exit(outcome === 'ok' ? 0 : 1)
}

console.log(`\n开始观察 ${SECONDS}s，请在手机微信里给机器人发一条消息…\n`)
await new Promise((resolve) => setTimeout(resolve, SECONDS * 1000))
await channel.stop()

console.log('\n=== 结果 ===')
console.log(bound ? '  ✅ 通道已绑定并进入长轮询' : '  ❌ 未完成绑定')
console.log(received ? `  ✅ 收到 ${received} 条、回复 ${replied} 条` : '  ⚠️ 这段时间没收到消息（不代表通道坏了）')
process.exit(bound ? 0 : 1)
