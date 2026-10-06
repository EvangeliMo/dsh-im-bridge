/**
 * 用**插件自己的通道代码**（lib/channels/qq.js）做一次真实往返验证。
 *
 * 与 test-qq-live.mjs 的区别：那个是独立的协议脚本，这个直接实例化插件要发布
 * 的那个类，所以它通过 = 插件在 DSH 里也能通过。
 *
 *   node scripts/test-qq-channel.mjs [--seconds 180]
 *
 * 收到单聊消息会调用 channel.sendText() 回显，覆盖插件真实的收/发两条路径。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createQqChannel } from '../lib/channels/qq.js'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const SECONDS = Number(flag('seconds', 180))

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CRED_FILE = path.join(HOME, 'storages', 'im_bridge_creds.json')

let qq = {}
try {
  qq = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'))?.qq ?? {}
} catch {
  /* handled below */
}
if (!qq.appId || !qq.appSecret) {
  console.error(`❌ 没读到 QQ 凭据：${CRED_FILE}`)
  process.exit(1)
}

console.log(`凭据: ${CRED_FILE}  appId=${qq.appId}  appSecret=***(len ${qq.appSecret.length})`)
console.log(`观察 ${SECONDS}s\n`)

let connected = false
let received = 0
let replied = 0

const channel = createQqChannel({
  appId: qq.appId,
  appSecret: qq.appSecret,
  sandbox: !!qq.sandbox,
  log: {
    info: (m) => console.log(`  [log] ${m}`),
    warn: (m) => console.log(`  [warn] ${m}`),
    error: (m) => console.log(`  [error] ${m}`),
  },
  onStatus: (status) => {
    console.log(`  [status] ${status.state}${status.detail ? ` (${status.detail})` : ''}`)
    if (status.state === 'online') connected = true
  },
  onMessage: async (message) => {
    received += 1
    console.log(`\n  📨 插件收到单聊消息: "${message.text}"  chatId=${message.chatId}`)
    try {
      await channel.sendText(message.chatId, `插件通道回声：${message.text}`)
      replied += 1
      console.log(`  ✅ 插件已回复（第 ${replied} 次）`)
    } catch (error) {
      console.log(`  ❌ 插件回复失败: ${error?.message ?? error}`)
    }
  },
})

await channel.start()
console.log('\n已启动，请在手机 QQ 里给机器人发一条消息…\n')

await new Promise((resolve) => setTimeout(resolve, SECONDS * 1000))
await channel.stop()

console.log('\n=== 结果 ===')
console.log(connected ? '  ✅ 插件通道鉴权成功（fiber 内可达 online）' : '  ❌ 插件通道未连上')
console.log(received ? `  ✅ 插件收到 ${received} 条、回复 ${replied} 条` : '  ⚠️ 这段时间没收到消息（不代表通道坏了，只是没人发）')
process.exit(connected ? 0 : 1)
