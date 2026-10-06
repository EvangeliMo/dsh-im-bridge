/**
 * 宿主冒烟测试：用假的 ctx 把「会话列表 → 编号进会话 → 提问 → 换模型 → 退出」
 * 整条链路跑一遍。不连 DSH、不连网络、不需要账号。
 *
 *   node scripts/test-host.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-im-bridge-test-'))
process.env.DSH_HOME = tmp

const { createSessions } = await import('../lib/sessions.js')
const { createRouter } = await import('../lib/router.js')
const { createStore } = await import('../lib/store.js')

// --------------------------------------------------------------------- 假数据

const WS_A = path.join(tmp, 'work', 'alpha')
const WS_B = path.join(tmp, 'work', 'beta')
fs.mkdirSync(WS_A, { recursive: true })
fs.mkdirSync(WS_B, { recursive: true })
const ARTIFACT = path.join(WS_A, 'report.md')
fs.writeFileSync(ARTIFACT, '# 一份报告\n\n内容\n', 'utf8')

const sessions = [
  { sessionId: 'session-aaa', cwd: WS_A, updatedAt: 3000, running: false, blank: false },
  { sessionId: 'session-bbb', cwd: WS_A, updatedAt: 2000, running: false, blank: false },
  { sessionId: 'session-ccc', cwd: WS_B, updatedAt: 1000, running: false, blank: false },
  { sessionId: 'session-ddd', cwd: 'D:\\work\\beta', updatedAt: 500, running: false, blank: true },
  { sessionId: 'session-eee', cwd: WS_A, updatedAt: 400, running: false, blank: false, origin: 'subagent' },
  // 孤儿：cwd 明明是 alpha 工作区，却没被挂载 → 应该出现在"未分组"，并能被 /归位 救回来
  { sessionId: 'session-orphan', cwd: WS_A, updatedAt: 300, running: false, blank: false },
]

const titles = {
  'session-aaa': '修复登录超时',
  'session-bbb': '重构渲染层',
  'session-ccc': '写周报',
}

/** 内存事件日志：seq -> event */
const logs = new Map()
let seqCounter = 0
let lastCreateCwd = null
let lastCreatePreset = null
let lastPromptContent = null
let rejectFileParts = false
let rejectImageParts = false
/** 记录 workspace.attachSession 调用，验证新会话被挂到工作区上。 */
const attached = []
let selectedModel = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' }

function push(sessionId, type, data) {
  seqCounter += 1
  const event = { type, seq: seqCounter, time: Date.now(), data }
  if (!logs.has(sessionId)) logs.set(sessionId, [])
  logs.get(sessionId).push(event)
  return event
}

for (const s of sessions) {
  logs.set(s.sessionId, [])
  push(s.sessionId, 'request/context', { provider: 'deepseek-official', model: 'deepseek-flash', contextWindow: 1000000 })
  push(s.sessionId, 'request/header', { header: { config: { ...selectedModel } } })
}
push('session-aaa', 'user/message', { role: 'user', content: [{ type: 'text', text: '登录接口 504 了' }] })
push('session-aaa', 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: '我先看一下网关日志。' }] } })
push('session-aaa', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
// 产物来源 1：模型显式声明交付；来源 2：写文件类工具调用
push('session-aaa', 'deliverables/presented', { turn: 1, callId: 'c1', files: [{ path: 'report.md', description: '一份报告' }] })
push('session-aaa', 'tool/call', { turn: 1, step: 1, callId: 'c2', name: 'write', arguments: JSON.stringify({ file_path: ARTIFACT, content: 'x' }) })

/** 真实 Host 会直接调用 signal.throwIfAborted()；漏传就复现线上那个报错。 */
function requireSignal(signal) {
  if (!signal || typeof signal.throwIfAborted !== 'function') {
    throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')")
  }
  signal.throwIfAborted()
}

const ctx = {
  get(service) {
    if (service === 'sessionController') {
      return {
        async list(_request, signal) {
          requireSignal(signal)
          return { items: sessions.map((s) => ({ ...s })) }
        },
        async prompt(request, signal) {
          requireSignal(signal)
          const { sessionId, content } = request
          // 复现 Host 的两种拒绝（都是线上真实报错原文）
          if (rejectFileParts && (content ?? []).some((part) => part?.type === 'file')) {
            throw new Error('File was not uploaded for this session.')
          }
          if (rejectImageParts && (content ?? []).some((part) => part?.type === 'image')) {
            throw new Error('prompt rejected')
          }
          lastPromptContent = content
          push(sessionId, 'user/message', { role: 'user', content })
          // 模拟模型立刻答完，让 waitForTurn 第一轮就取到 turn/end
          push(sessionId, 'assistant/message', {
            message: { role: 'assistant', content: [{ type: 'text', text: `收到：「${content[0].text}」。这是模拟回答。` }] },
          })
          push(sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
          return { accepted: true }
        },
        async cancel() {
          return { accepted: true }
        },
        async modelCatalog() {
          return {
            default: { provider: 'deepseek-official', model: 'deepseek-flash' },
            groups: [
              {
                id: 'deepseek-official',
                name: 'DeepSeek 官方',
                models: [
                  { id: 'deepseek-flash', name: 'deepseek-flash', reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }], defaultEffort: 'high' } },
                  { id: 'deepseek-pro', name: 'deepseek-pro' },
                ],
              },
              { id: 'openrouter', name: 'OpenRouter', models: [{ id: 'x-ai/grok-4.7', name: 'Grok 4.7' }] },
            ],
          }
        },
        async selectModel({ provider, model, reasoningEffort }) {
          selectedModel = { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }
          return { selected: selectedModel }
        },
        async create(request = {}) {
          lastCreateCwd = request.cwd ?? null
          lastCreatePreset = request.agentPreset ?? null
          const id = `session-new-${Math.random().toString(36).slice(2, 8)}`
          sessions.unshift({ sessionId: id, cwd: request.cwd ?? WS_A, updatedAt: Date.now(), running: false, blank: false })
          logs.set(id, [])
          if (request.agentPreset) push(id, 'agent-preset/selected', { agentPreset: request.agentPreset })
          push(id, 'request/context', { provider: 'deepseek-official', model: 'deepseek-flash' })
          return { sessionId: id, ...(request.agentPreset ? { agentPreset: request.agentPreset } : {}) }
        },
      }
    }
    if (service === 'agentPresets') {
      return {
        async remoteExportList() {
          return {
            presets: [
              { id: 'standard', isDefault: true, name: '标准' },
              { id: 'minimal', isDefault: false, name: '极简' },
              { id: 'ptc', isDefault: false, name: 'PTC' },
              { id: 'cordis', isDefault: false, name: 'Cordis' },
              { id: 'my-mode', isDefault: false, name: '我的插件模式' },
            ],
          }
        },
      }
    }
    if (service === 'sessionQuery') {
      return {
        async readTitleSnapshots(ids, signal) {
          requireSignal(signal)
          return ids.map((sessionId) => ({
            sessionId,
            status: 'fulfilled',
            value: { session: { id: sessionId }, ...(titles[sessionId] ? { title: { title: titles[sessionId] } } : {}) },
          }))
        },
        async listEvents(sessionId) {
          return (logs.get(sessionId) ?? []).map((e) => ({ sessionId, seq: e.seq, type: e.type, time: e.time }))
        },
        async readSession(sessionId) {
          const record = sessions.find((s) => s.sessionId === sessionId)
          return { session: { id: sessionId, cwd: record?.cwd }, events: logs.get(sessionId) ?? [] }
        },
      }
    }
    if (service === 'workspaceRegistry') {
      const make = (id, title, dir, sessionIds) => ({
        id,
        title,
        path: dir,
        sessionIds,
        // 真实 Workspace 上的挂载入口；新建会话必须调它才会进工作区分组。
        async attachSession(sessionId) {
          attached.push({ workspaceId: id, sessionId })
        },
      })
      const all = () => [
        make('ws-a', 'alpha', WS_A, ['session-aaa', 'session-bbb', 'session-eee']),
        make('ws-b', 'beta', WS_B, ['session-ccc', 'session-ddd']),
      ]
      return {
        list: all,
        get(id) {
          return all().find((w) => w.id === id)
        },
      }
    }
    return undefined
  },
}

// --------------------------------------------------------------------- 跑流程

const log = { info: () => {}, warn: (...a) => console.warn('  ! ', ...a), error: (...a) => console.error('  !!', ...a) }
const store = createStore(log)
const adapter = createSessions(ctx, log)
// 附件组装用桩：按真实 shape 翻成 content parts（图片=编码形态，文件=receiptId）。
const media = {
  async build({ text, attachments, forceFile }) {
    const parts = []
    if (String(text ?? '').trim()) parts.push({ type: 'text', text })
    for (const [i, attachment] of attachments.entries()) {
      if (attachment.kind === 'image' && !forceFile) {
        parts.push({ type: 'image', mediaType: 'image/jpeg', data: 'QUJD', name: attachment.name })
      } else {
        parts.push({ type: 'file', receiptId: `receipt-${i}` })
      }
    }
    return parts
  },
  withoutFiles: (parts) => (parts ?? []).filter((part) => part?.type !== 'file'),
}
const router = createRouter({ sessions: adapter, store, log, config: {}, media })

const CHANNEL = 'test'
const CHAT = 'chat-1'
const transcript = []

async function say(text, mediaInput) {
  const replies = []
  const sentFiles = []
  const reply = async (line) => {
    replies.push(line)
  }
  reply.file = async (absPath, name) => {
    sentFiles.push({ absPath, name })
  }
  await router.handle({ channelId: CHANNEL, chatId: CHAT, userId: CHAT, text, ...(mediaInput ? { media: mediaInput } : {}) }, reply)
  transcript.push({ text, replies, sentFiles })
  console.log(`\n🧑 ${text}`)
  for (const line of replies) console.log(`🤖 ${line.split('\n').map((l, i) => (i ? `   ${l}` : l)).join('\n')}`)
  for (const f of sentFiles) console.log(`📎 [附件] ${f.name} <- ${f.absPath}`)
  return replies
}

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`)
  } else {
    console.error(`  ❌ ${label}`)
    process.exitCode = 1
  }
}

await say('/帮助')
await say('/会话列表')
await say('1.1')

console.log('\n--- 断言 ---')
assert(transcript[0].replies[0].includes('/会话列表'), '帮助里有指令说明')

const listText = transcript[1].replies[0]
assert(listText.includes('alpha') && listText.includes('beta'), '会话列表按工作区分组')
assert(listText.includes('1.1') && listText.includes('2.1'), '会话带编号 1.1 / 2.1')
assert(!listText.includes('session-eee'), '子代理会话被排除')
assert(!listText.includes('session-ddd'), '空白会话默认被排除')
assert(listText.includes('修复登录超时'), '标题已渲染')

const bindText = transcript[2].replies[0]
assert(bindText.includes('session-aaa'), '编号 1.1 进入正确会话')
assert(bindText.includes('修复登录超时'), '进入时回显标题')
assert(bindText.includes('alpha'), '进入时回显所属工作区')

await say('帮我看下这个 504')
assert(transcript[3].replies.some((r) => r.includes('已提交')), '提问有已提交回执')
assert(transcript[3].replies.some((r) => r.includes('模拟回答')), '拿到模型回答')

await say('/模型')
const modelText = transcript[4].replies[0]
assert(modelText.includes('deepseek-flash') && modelText.includes('Grok 4.7'), '模型目录已列出')

await say('/模型 2')
assert(transcript[5].replies[0].includes('deepseek-pro'), '按编号切换模型')

await say('/思考 low')
assert(transcript[6].replies[0].includes('low'), '切换思考强度')

await say('/历史 10')
assert(transcript[7].replies[0].includes('登录接口 504'), '历史里能看到早期消息')

await say('/退出')
assert(transcript[8].replies[0].includes('已解除'), '退出解绑')

await say('/会话列表')
await say('9.9')
assert(transcript[10].replies[0].includes('找不到编号'), '越界编号被拒绝')

await say('1.1')
await say('/产物')
assert(transcript[12].replies[0].includes('report.md'), '产物列表列出交付文件')
assert(transcript[12].replies[0].includes('产出 1 个文件'), '同一文件按绝对路径归并去重')

await say('/产物 1')
assert(transcript[13].sentFiles.length === 1, '按编号发送了附件')
assert(transcript[13].sentFiles[0].absPath === ARTIFACT, '发送的是正确的绝对路径')

await say('/发文件 C:\\Windows\\win.ini')
assert(transcript[14].replies[0].includes('只允许发送工作区内'), '越界路径被拒绝')

await say('/发文件 report.md')
assert(transcript[15].sentFiles.length === 1, '相对路径按工作区解析后可发送')

// ---- 解析器健壮性 + /新建 按工作区名字 + /工作区 ----

await say('/工作区')
assert(transcript[16].replies[0].includes('alpha') && transcript[16].replies[0].includes(WS_A), '工作区列表带编号和路径')

await say('/新建 alpha')
assert(transcript[17].replies[0].includes('工作区 alpha'), '按工作区名字新建')
assert(lastCreateCwd === WS_A, `新建时把 cwd 解析成了 ${WS_A}`)
assert(
  attached.some((a) => a.workspaceId === 'ws-a' && a.sessionId.startsWith('session-new-')),
  '新建的会话被挂到了工作区上（否则会掉进未分组）',
)

// 全角空格（U+3000）—— 手机中文输入法最常带进来的分隔符
await say('/新建\u3000beta')
assert(transcript[18].replies[0].includes('工作区 beta'), '全角空格也能解析')
assert(lastCreateCwd === WS_B, '全角空格下 cwd 解析正确')

// 零宽空格 + 完全没有分隔符
await say('/新建\u200Balpha')
assert(transcript[19].replies[0].includes('工作区 alpha'), '零宽字符被剥掉')

await say('/新建beta')
assert(transcript[20].replies[0].includes('工作区 beta'), '无分隔符的前缀匹配也能工作')

await say('/新建 不存在的工作区')
assert(transcript[21].replies[0].includes('没有叫'), '不存在的工作区给出可选项')

await say('/会话列表 alpha')
const onlyAlpha = transcript[22].replies[0]
assert(onlyAlpha.includes('alpha') && !onlyAlpha.includes('beta'), '只列指定工作区')

// /归位：把 cwd 属于某工作区、但没被挂载的会话补挂
attached.length = 0
const regroupReplies = await say('/归位')
assert(regroupReplies[0].includes('归位'), '未分组里的孤儿会话被归位')
assert(attached.some((a) => a.sessionId === 'session-orphan'), '孤儿会话 session-orphan 被挂到 alpha')

// ---- 模式（Agent Preset）----
const modeList = await say('/模式')
assert(modeList[0].includes('我的插件模式') && modeList[0].includes('标准'), '模式列表列出全部 5 个模式')
assert(modeList[0].includes('Host 默认'), '标出 Host 默认模式')

const modeSet = await say('/模式 2')
assert(modeSet[0].includes('minimal'), '按编号切换模式')

lastCreatePreset = null
await say('/新建 alpha')
assert(lastCreatePreset === 'minimal', '新建会话时带上了所选模式')

const modeDefault = await say('/模式 默认')
assert(modeDefault[0].includes('Host 默认'), '可恢复跟随 Host 默认')

lastCreatePreset = 'sentinel'
await say('/新建 alpha')
assert(lastCreatePreset === null, '恢复默认后不再传 agentPreset')

const modeById = await say('/模式 my-mode')
assert(modeById[0].includes('my-mode'), '按 id 切换模式')

const badMode = await say('/模式 不存在')
assert(badMode[0].includes('没有叫'), '不存在的模式给出提示')

// ---- 入站附件：必须能走通 router → media → prompt ----
// （这条能抓住"createRouter 忘了声明 media 参数"那类错误）
lastPromptContent = null
const withImage = await say('看看这张图', [{ kind: 'image', name: 'a.png', url: 'https://cdn/1' }])
assert(withImage.some((r) => r.includes('收到 1 个附件')), '有附件时先给回执')
assert(
  Array.isArray(lastPromptContent) && lastPromptContent.some((p) => p.type === 'image' && p.mediaType && p.data),
  '图片以编码形态（mediaType + data）进 prompt',
)
assert(
  lastPromptContent.some((p) => p.type === 'text' && p.text.includes('看看这张图')),
  '正文与附件在同一个 prompt 里',
)
assert(withImage.some((r) => r.includes('模拟回答')), '带附件也能拿到模型回答')

// 图片被 Host 拒（例如像素超限）：第 2 档把图片改成文件附件
rejectImageParts = true
lastPromptContent = null
const imageDegraded = await say('大图看看', [{ kind: 'image', name: 'big.png', url: 'https://cdn/big' }])
rejectImageParts = false
assert(imageDegraded.some((r) => r.includes('图片没被接纳')), '图片被拒时提示已改为文件附件')
assert(
  Array.isArray(lastPromptContent) && lastPromptContent.some((p) => p.type === 'file' && p.receiptId),
  '第 2 档用 fileUploads 的 receiptId 送达',
)
assert(
  lastPromptContent.some((p) => p.type === 'text' && p.text.includes('大图看看')),
  '降级后正文仍在',
)

// 文件附件：正常路径用 receiptId 送进 prompt
lastPromptContent = null
await say('这是文件', [{ kind: 'file', name: 'a.bin', url: 'https://cdn/a' }])
assert(
  Array.isArray(lastPromptContent) && lastPromptContent.some((p) => p.type === 'file' && p.receiptId),
  '文件用 receiptId 送进 prompt',
)

// 文件被 Host 拒（未暂存）：必须去掉文件重发，正文不能丢
rejectFileParts = true
lastPromptContent = null
const rejected = await say('正文不能丢', [{ kind: 'file', name: 'b.bin', url: 'https://cdn/b' }])
rejectFileParts = false
assert(rejected.some((r) => r.includes('没被接纳')), '文件被拒时给出降级提示')
assert(
  Array.isArray(lastPromptContent) && lastPromptContent.some((p) => p.type === 'text' && p.text.includes('正文不能丢')),
  '降级重发仍然带上了正文',
)
assert(!lastPromptContent.some((p) => p.type === 'file'), '降级后不再包含 file part')

// 这次线上踩到的坑：相对路径的 cwd 被原样丢给 DSH，报
// 'session header cwd must be an absolute path'。必须在插件内拦住。
const strictRouter = createRouter({
  sessions: adapter,
  store,
  log,
  config: { defaultCwd: 'relative-dir' },
})
const guarded = []
await strictRouter.handle(
  { channelId: CHANNEL, chatId: 'chat-guard', userId: 'chat-guard', text: '你好' },
  async (line) => { guarded.push(line) },
)
assert(guarded.some((r) => r.includes('必须是绝对路径')), '相对 cwd 被插件拦住并给出可读提示')

await store.flush()
fs.rmSync(tmp, { recursive: true, force: true })

console.log(`\n${process.exitCode ? '❌ 有断言失败' : '✅ 全部通过'}（共 ${transcript.length} 轮对话）`)
