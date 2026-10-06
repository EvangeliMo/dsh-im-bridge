/**
 * 入口级冒烟测试：直接调用插件的 apply(ctx)，验证装配阶段不会炸。
 *
 * 这一步专门覆盖「装完重启才发现插件起不来」那类问题：
 *   - createSessions / createRouter / createStore 能否构造
 *   - 没有 QQ 凭据时是否安全跳过
 *   - 是否注册了 /im 命令、状态是否可读、是否返回了 disposer
 *   - disposer 调用后是否干净收尾
 *
 * 全程不连网络（微信无 token 时只置为 need-login，QQ 无凭据直接跳过）。
 *
 *   node scripts/test-apply.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-im-bridge-apply-'))
process.env.DSH_HOME = tmp

const plugin = await import('../lib/index.js')

let commandsRegistered = []
const statuses = []

const ctx = {
  logger: () => ({ info: () => {}, warn: (...a) => console.warn('  ! ', ...a), error: (...a) => console.error('  !!', ...a) }),
  get(service) {
    if (service === 'sessionController') {
      return {
        async list() { return { items: [] } },
        async prompt() { return { accepted: true } },
        async cancel() { return { accepted: true } },
        async modelCatalog() { return { groups: [] } },
        async selectModel() { return { selected: {} } },
        async create() { return { sessionId: 'session-x' } },
      }
    }
    if (service === 'sessionQuery') {
      return {
        async readTitleSnapshots() { return [] },
        async listEvents() { return [] },
        async readSession() { return { session: {}, events: [] } },
      }
    }
    if (service === 'workspaceRegistry') return { list: () => [] }
    if (service === 'commands') {
      return {
        register(definition) {
          commandsRegistered.push(definition)
          return () => { commandsRegistered = commandsRegistered.filter((d) => d !== definition) }
        },
      }
    }
    return undefined
  },
}

function assert(condition, label) {
  if (condition) console.log(`  ✅ ${label}`)
  else {
    console.error(`  ❌ ${label}`)
    process.exitCode = 1
  }
}

console.log('--- apply() ---')
const dispose = plugin.apply(ctx, {})
assert(typeof dispose === 'function', 'apply() 返回 disposer 函数')
assert(plugin.name === 'dsh-im-bridge', `插件名正确 (${plugin.name})`)
assert(Array.isArray(plugin.inject) && plugin.inject.includes('sessionController'), `inject 声明正确 (${plugin.inject})`)

console.log('\n--- /im 命令 ---')
assert(commandsRegistered.length === 1, '注册了一个 /im 命令')
const command = commandsRegistered[0]
assert(command?.name === 'im', `命令名是 im (${command?.name})`)
assert(typeof command?.description === 'string' && command.description.length > 0, '命令有描述')

const statusResult = await command.handler({ rawInput: 'status' })
assert(statusResult.kind === 'success', '/im status 返回 success')
assert(statusResult.text.includes('wechat'), '状态里列出了微信通道')
assert(statusResult.text.includes('unconfigured'), '未配置 QQ 时明确标注 unconfigured')

const qrResult = await command.handler({ rawInput: 'unknown-sub' })
assert(qrResult.kind === 'error', '未知子命令返回 error')

console.log('\n--- disposer ---')
await dispose()
assert(commandsRegistered.length === 0, 'disposer 注销了 /im 命令')

// 等待 store 的合并写盘定时器结束，避免留下挂起句柄
await new Promise((resolve) => setTimeout(resolve, 120))
fs.rmSync(tmp, { recursive: true, force: true })

console.log(`\n${process.exitCode ? '❌ 有断言失败' : '✅ 全部通过'}`)
