/**
 * QQ 通道联调脚本（独立于 DSH，用来快速定位"连不上"到底卡在哪一步）。
 *
 *   node scripts/test-qq-live.mjs [--seconds 60] [--sandbox] [--echo]
 *
 * 依次做四件事并逐步打印结果：
 *   1. AppID/AppSecret → access_token
 *   2. GET /gateway
 *   3. WebSocket 连接 + IDENTIFY(intents = 1<<25)
 *   4. 观察事件；--echo 时自动回复收到的单聊消息
 *
 * 凭据从 %DSH_HOME%\storages\im_bridge_creds.json 的 qq 段读取，**不会打印 secret**。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const has = (name) => args.includes(`--${name}`)

const SECONDS = Number(flag('seconds', 60))
const SANDBOX = has('sandbox')
const ECHO = has('echo')
const INTENT_GROUP_AND_C2C = 1 << 25

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CRED_FILE = path.join(HOME, 'storages', 'im_bridge_creds.json')

function loadQqCreds() {
  let fromFile = {}
  try {
    fromFile = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'))?.qq ?? {}
  } catch {
    /* ignore */
  }
  return {
    appId: process.env.QQBOT_APP_ID || fromFile.appId,
    appSecret: process.env.QQBOT_APP_SECRET || fromFile.appSecret,
  }
}

const CLOSE_HINTS = {
  4004: 'token 无效 → 检查 AppID/AppSecret',
  4006: 'session 失效 → 需要重新 IDENTIFY',
  4007: 'seq 不连续',
  4008: '发送过于频繁',
  4013: 'intents 无效',
  4014: '机器人已下架 / 无该 intents 权限 → 开放平台申请「单聊消息」事件权限，或改用 --sandbox',
  4900: '内部错误，可重连',
  4914: '机器人已下架，只允许连沙箱 → 机器人未上线：改用 --sandbox',
  4915: '机器人已被封禁',
}

const step = (n, text) => console.log(`\n[${n}] ${text}`)
const ok = (text) => console.log(`    ✅ ${text}`)
const bad = (text) => console.log(`    ❌ ${text}`)

const { appId, appSecret } = loadQqCreds()
if (!appId || !appSecret) {
  bad(`没读到 QQ 凭据。请在 ${CRED_FILE} 里写 {"qq":{"appId":"...","appSecret":"..."}}`)
  process.exit(1)
}
console.log(`凭据来源: ${CRED_FILE}  appId=${appId}  appSecret=***(len ${appSecret.length})`)
console.log(`模式: ${SANDBOX ? 'sandbox' : 'production'}  intents=${INTENT_GROUP_AND_C2C}  观察 ${SECONDS}s`)

const apiBase = SANDBOX ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.bot.qq.com'
const fetchJson = async (url, options = {}) => {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20_000) })
  const text = await response.text()
  let json
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    json = { raw: text }
  }
  return { status: response.status, json }
}

// ---------------------------------------------------------------- 1. token
step(1, 'POST /app/getAppAccessToken')
const tokenRes = await fetchJson('https://api.bot.qq.com/app/getAppAccessToken', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ appId, clientSecret: appSecret }),
})
if (tokenRes.json?.code) {
  bad(`取 token 失败: code=${tokenRes.json.code} ${tokenRes.json.message ?? ''}`)
  console.log('   提示: 100007=AppID 无效 / 100016=AppID 或 Secret 无效 / 10004=机器人不存在')
  process.exit(1)
}
const token = tokenRes.json?.access_token
if (!token) {
  bad(`没有 access_token: ${JSON.stringify(tokenRes.json).slice(0, 200)}`)
  process.exit(1)
}
ok(`拿到 access_token（长度 ${token.length}，${tokenRes.json.expires_in}s 有效）`)

const auth = { Authorization: `QQBot ${token}` }

// ---------------------------------------------------------------- 2. gateway
step(2, `GET ${apiBase}/gateway`)
const gwRes = await fetchJson(`${apiBase}/gateway`, { headers: auth })
if (!gwRes.json?.url) {
  bad(`没有拿到网关地址: HTTP ${gwRes.status} ${JSON.stringify(gwRes.json).slice(0, 200)}`)
  console.log('   提示: 若 401，试试加 --sandbox')
  process.exit(1)
}
ok(`网关地址 ${gwRes.json.url}`)

// ---------------------------------------------------------------- 3+4. WS
step(3, 'WebSocket 连接 + IDENTIFY')
if (typeof WebSocket !== 'function') {
  bad('当前 Node 没有全局 WebSocket（需要 Node 22+）')
  process.exit(1)
}

let seq = null
let sawReady = false
let replied = 0
const ws = new WebSocket(gwRes.json.url)

const finish = (code) => {
  try {
    ws.close()
  } catch {
    /* noop */
  }
  console.log(`\n=== 结果 ===`)
  if (sawReady) ok('WebSocket 已鉴权成功（intent 权限正常）')
  else bad('WebSocket 未完成鉴权')
  process.exit(code)
}

const timer = setTimeout(() => finish(sawReady ? 0 : 1), SECONDS * 1000)

ws.onopen = () => ok('TCP/WS 已连接，等待 Hello(op 10)')

ws.onmessage = async (event) => {
  let payload
  try {
    payload = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
  } catch {
    return
  }
  if (typeof payload.s === 'number') seq = payload.s

  if (payload.op === 10) {
    ws.send(JSON.stringify({
      op: 2,
      d: { token: `QQBot ${token}`, intents: INTENT_GROUP_AND_C2C, shard: [0, 1], properties: {} },
    }))
    console.log(`    → 已发送 IDENTIFY（心跳间隔 ${payload.d?.heartbeat_interval}ms）`)
    return
  }
  if (payload.op === 11) return
  if (payload.op === 0) {
    if (!sawReady) {
      sawReady = true
      console.log(`    → 收到首个 dispatch: ${payload.t}`)
      console.log(`\n[4] 开始观察 ${SECONDS}s，请在手机 QQ 里给机器人发一条消息…`)
    }
    if (payload.t === 'C2C_MESSAGE_CREATE') {
      const msg = payload.d
      const openid = msg?.author?.user_openid
      console.log(`    📨 收到单聊消息: "${msg?.content}"  from=${openid}`)
      if (ECHO && openid) {
        replied += 1
        const body = { content: `收到：${msg.content}`, msg_type: 0, msg_id: msg.id, msg_seq: replied }
        const send = await fetchJson(`${apiBase}/v2/users/${encodeURIComponent(openid)}/messages`, {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (send.json?.code) bad(`回复失败: ${send.json.code} ${send.json.message ?? ''}`)
        else ok(`已回复（第 ${replied} 次被动回复）`)
      }
    } else {
      console.log(`    · 事件 ${payload.t}`)
    }
    return
  }
  if (payload.op === 7) {
    console.log('    → RECONNECT')
    return
  }
  if (payload.op === 9) {
    bad('Invalid Session')
    return
  }
}

ws.onerror = () => bad('WebSocket 错误事件')

ws.onclose = (event) => {
  clearTimeout(timer)
  const code = event?.code
  console.log(`\n=== 连接关闭 === code=${code} reason=${event?.reason || '(空)'}`)
  if (CLOSE_HINTS[code]) console.log(`   含义: ${CLOSE_HINTS[code]}`)
  else if (code === 1000 || code === 1005) console.log('   正常关闭')
  console.log(sawReady
    ? '   ✅ 曾成功鉴权；如果只是被定时器关掉，说明通道可用'
    : '   ❌ 从未完成鉴权，按上面的含义排查')
  process.exit(sawReady ? 0 : 1)
}
