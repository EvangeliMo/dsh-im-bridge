/**
 * Command router: turns one inbound chat message into zero or more outbound
 * chat messages.
 *
 * Deliberately channel-agnostic and pure-ish: it never touches a network API,
 * it only calls the `sessions` adapter, the `store`, and the `send` callback it
 * was handed. That makes the whole command surface testable with
 * `node scripts/test-host.mjs`, with no IM account and no DSH process involved.
 *
 * `send` is the outbound callback: call it as a function to send text, and use
 * `send.file(absPath, name)` to send an attachment.
 */
import fs from 'node:fs'
import path from 'node:path'

import { isInsideAny } from './artifacts.js'
import {
  chunkText,
  formatArtifacts,
  formatBind,
  formatEfforts,
  formatHistory,
  formatModelCatalog,
  formatPresets,
  formatSessionList,
  HELP_TEXT,
  oneLine,
} from './render.js'

/** Command aliases (Chinese first — this is the primary audience). */
const ALIASES = {
  '帮助': 'help', help: 'help', '?': 'help', '？': 'help', '指令': 'help',
  '会话列表': 'sessions', '获取会话列表': 'sessions', '列表': 'sessions',
  ls: 'sessions', sessions: 'sessions', '会话': 'sessions',
  '进入': 'enter', enter: 'enter', '切换': 'enter', session: 'enter', '选': 'enter',
  '当前': 'current', current: 'current',
  '状态': 'status', status: 'status', '健康': 'status',
  '历史': 'history', history: 'history', '上下文': 'history', context: 'history',
  '模型': 'model', model: 'model', models: 'model',
  '思考': 'think', think: 'think', reasoning: 'think',
  '停止': 'stop', stop: 'stop', '打断': 'stop', cancel: 'stop', '取消': 'stop',
  '退出': 'exit', exit: 'exit', '离开': 'exit',
  '新建': 'new', new: 'new',
  '工作区': 'workspaces', workspaces: 'workspaces', ws: 'workspaces', '工作目录': 'workspaces',
  '归位': 'regroup', '整理': 'regroup', regroup: 'regroup', '分组': 'regroup',
  '模式': 'preset', '预设': 'preset', '模式列表': 'preset', preset: 'preset', presets: 'preset', mode: 'preset',
  '详细': 'verbose', verbose: 'verbose',
  '问': 'ask', '说': 'ask', ask: 'ask', say: 'ask',
  '产物': 'artifacts', '交付': 'artifacts', '产出': 'artifacts', artifacts: 'artifacts', files: 'artifacts',
  '发文件': 'sendfile', sendfile: 'sendfile', '传文件': 'sendfile',
}

const NUMBER_RE = /^\d+(?:\.\d+)?$/

/**
 * 把被兜底 message 遮住的真实原因翻出来。
 * Host 很多地方会把底层异常统一成 "prompt rejected"，真正的内容在 reason/data 里。
 */
export function describeError(error) {
  if (!error) return String(error)
  const bits = [String(error.message ?? error)]
  for (const key of ['code', 'reason', 'data', 'cause']) {
    const value = error[key]
    if (value === undefined || value === null) continue
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
    if (text && !bits.includes(text)) bits.push(`${key}=${text.slice(0, 240)}`)
  }
  return bits.join(' | ')
}

/** 最长优先，避免「会话」抢在「会话列表」前面匹配。 */
const ALIAS_KEYS = Object.keys(ALIASES).sort((a, b) => b.length - a.length)

function normalize(raw) {
  let text = String(raw ?? '').trim()
  text = text
    // 零宽字符：手机输入法/复制粘贴很容易带进来，看不见但会把指令切开。
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    // 各种 Unicode 空格（全角空格 U+3000、不换行空格 U+00A0…）统一成普通空格。
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
    .replace(/／/g, '/')
    .replace(/．/g, '.')
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))

  const isCommand = text.startsWith('/')
  const body = isCommand ? text.replace(/^\/+/, '').replace(/\/+$/, '').trim() : text

  const firstWord = body.split(' ')[0] ?? ''
  let command = ALIASES[firstWord.toLowerCase()] ?? ALIASES[firstWord] ?? null
  let rest = command ? body.slice(firstWord.length) : body

  // 兜底：分隔符缺失或被漏掉时（「新建Harness」「新建　Harness」），
  // 按最长别名做前缀匹配 —— 只有带 / 的输入才会走这里。
  if (isCommand && !command) {
    for (const key of ALIAS_KEYS) {
      if (body.startsWith(key)) {
        command = ALIASES[key]
        rest = body.slice(key.length)
        break
      }
    }
  }

  const trimmed = rest.trim()
  return {
    isCommand,
    head: firstWord,
    command,
    args: trimmed ? trimmed.split(/\s+/) : [],
    argText: trimmed,
    raw: text,
  }
}

export function createRouter({ sessions, store, log = console, config = {}, media = null }) {
  const replyTimeoutMs = config.replyTimeoutMs ?? 15 * 60_000

  async function refreshList(channelId, chatId, onlyWorkspace) {
    const list = await sessions.listAll({
      includeBlank: config.includeBlank,
      perWorkspace: config.listLimit ?? 15,
      onlyWorkspace,
    })
    store.setChat(channelId, chatId, {
      lastList: list.flat.map(({ n, sessionId, title, workspaceTitle }) => ({ n, sessionId, title, workspaceTitle })),
    })
    return list
  }

  /** Resolve a display number (1.2), a 1-based index, or a raw session id. */
  async function resolveTarget(channelId, chatId, token) {
    const raw = String(token ?? '').trim()
    if (!raw) return null
    const state = store.getChat(channelId, chatId)

    const cached = (state.lastList ?? []).find((item) => item.n === raw)
    if (cached) return { ...cached, source: 'cache' }

    if (/^session-/.test(raw)) return { n: null, sessionId: raw, title: '(按 id 指定)' }

    const list = await refreshList(channelId, chatId)
    const found = sessions.resolve(list, raw)
    return found ? { ...found, source: 'fresh' } : null
  }

  /**
   * Send one file to the chat, with a workspace containment check.
   * Files outside every registered workspace root are refused unless
   * `config.allowAnyPath` is set — the IM channel must not become a way to
   * exfiltrate arbitrary files from the machine.
   */
  async function sendArtifact(absPath, name, reply, state) {
    if (typeof reply.file !== 'function') {
      await reply('⚠️ 当前通道不支持发送文件。')
      return
    }
    const roots = sessions.allowedRoots(state.sessionId)
    if (!config.allowAnyPath && !isInsideAny(absPath, roots)) {
      await reply([
        '⛔ 出于安全，只允许发送工作区内的文件。',
        '允许的根目录：',
        ...roots.slice(0, 6).map((r) => `  ${r}`),
      ].join('\n'))
      return
    }
    let stat
    try {
      stat = fs.statSync(absPath)
    } catch {
      await reply(`❓ 文件不存在：${absPath}`)
      return
    }
    if (!stat.isFile()) {
      await reply(`❓ 不是普通文件：${absPath}`)
      return
    }
    const maxBytes = config.maxFileBytes ?? 20 * 1024 * 1024
    if (stat.size > maxBytes) {
      await reply(`⚠️ 文件 ${(stat.size / 1048576).toFixed(1)}MB，超过上限 ${Math.round(maxBytes / 1048576)}MB。`)
      return
    }
    const fileName = name || path.basename(absPath)
    await reply(`📎 正在发送 ${fileName}（${(stat.size / 1024).toFixed(0)}KB）…`)
    try {
      await reply.file(absPath, fileName)
      await reply(`✅ 已发送 ${fileName}`)
    } catch (error) {
      await reply(`❌ 发送失败：${error?.message ?? error}`)
    }
  }

  async function describeBinding(item) {
    const model = await sessions.currentModel(item.sessionId)
    const preset = await sessions.currentPreset(item.sessionId).catch(() => null)
    let recent = []
    try {
      recent = await sessions.history(item.sessionId, 5)
    } catch (error) {
      log.warn?.(`[im-bridge] 读取历史失败: ${error?.message ?? error}`)
    }
    return formatBind({
      n: item.n,
      sessionId: item.sessionId,
      title: item.title,
      workspaceTitle: item.workspaceTitle,
      preset,
      model,
      recent,
    })
  }

  async function enter(channelId, chatId, token, reply) {
    const target = await resolveTarget(channelId, chatId, token)
    if (!target) {
      await reply(`❓ 找不到编号「${token}」。先发「/会话列表」看看。\n（要发送纯数字文本，请用「/问 ${token}」）`)
      return
    }
    store.bind(channelId, chatId, target.sessionId)
    await reply(await describeBinding(target))
  }

  /** A plain sentence: send it to the bound session, creating one if needed. */
  async function ask(msg, reply, text) {
    const { channelId, chatId } = msg
    let state = store.getChat(channelId, chatId)
    let sessionId = state.sessionId

    if (!sessionId) {
      const workspaces = sessions.workspaces()
      let cwd = config.defaultCwd ?? workspaces[0]?.path ?? null
      if (cwd && !path.isAbsolute(cwd)) {
        await reply(`❌ 工作区路径必须是绝对路径，得到的是「${cwd}」。改用「/新建 <工作区名>」。`)
        return
      }
      let created
      try {
        created = await sessions.createSession({
          ...(cwd ? { cwd } : {}),
          ...(state.agentPreset ? { agentPreset: state.agentPreset } : {}),
        })
      } catch (error) {
        await reply(`❌ 新建会话失败：${error?.message ?? error}`)
        return
      }
      sessionId = created.sessionId
      // 只给 cwd 不会让会话出现在工作区分组里，必须显式挂载。
      const owner = workspaces.find((w) => w.path === cwd)
      if (owner) await sessions.attachToWorkspace(owner.id, sessionId)
      store.bind(channelId, chatId, sessionId)
      await reply([
        `🆕 新会话 ${sessionId}`,
        created.agentPreset ? `🧩 模式 ${created.agentPreset}` : null,
        cwd ? `📁 ${cwd}` : null,
      ].filter(Boolean).join('\n'))
    }

    const before = await sessions.lastSeq(sessionId)
    const attachments = msg.media ?? []
    if (attachments.length) await reply(`📎 收到 ${attachments.length} 个附件`)

    // 三档递降：原样 → 图片改按文件附 → 只发正文。
    // 任何一档成功，正文都不会丢；降级时给出用户可见的提示。
    const textOnly = async () => [{ type: 'text', text }]
    const steps = []
    if (attachments.length && media?.build) {
      steps.push({ build: () => media.build({ text, attachments, sessionId }), note: null })
      if (attachments.some((item) => item.kind === 'image')) {
        steps.push({
          build: () => media.build({ text, attachments, sessionId, forceFile: true }),
          note: '⚠️ 图片没被接纳，已改为按文件附加。',
        })
      }
      steps.push({ build: textOnly, note: '⚠️ 附件没被接纳，本次只发送了正文。' })
    } else {
      steps.push({ build: textOnly, note: null })
    }

    let promptError = null
    for (const [index, step] of steps.entries()) {
      let content
      try {
        content = await step.build()
      } catch (error) {
        promptError = error
        log.warn?.(`[im-bridge] 附件组装失败（第 ${index + 1} 档）: ${describeError(error)}`)
        continue
      }
      try {
        await sessions.prompt(sessionId, content)
        if (index > 0 && step.note) await reply(step.note)
        promptError = null
        break
      } catch (error) {
        promptError = error
        log.warn?.(`[im-bridge] prompt 第 ${index + 1} 档被拒: ${describeError(error)}`)
      }
    }
    if (promptError) throw promptError
    await reply('⏳ 已提交，正在思考…')

    const done = await sessions.waitForTurn(sessionId, before, { timeoutMs: replyTimeoutMs })
    if (!done.ok) {
      await reply(done.reason === 'timeout' ? '⌛️ 等待超时，稍后用「/历史」查看结果。' : '⏹ 已中止。')
      return
    }
    const answer = await sessions.lastAnswer(sessionId, before)
    for (const chunk of chunkText(answer || '（模型这一轮没有输出文本）')) await reply(chunk)
  }

  async function handle(msg, reply) {
    const { channelId, chatId } = msg
    const parsed = normalize(msg.text)
    const state = store.getChat(channelId, chatId)

    // A bare "1.2" is always an attempt to enter that session — never a prompt,
    // otherwise a stale number would silently turn into a model request.
    if (!parsed.isCommand && NUMBER_RE.test(parsed.raw)) {
      await enter(channelId, chatId, parsed.raw, reply)
      return
    }

    const command = parsed.command
    if (!parsed.isCommand || !command) {
      if (parsed.isCommand) {
        await reply(`❓ 未知指令「${parsed.raw}」，发「/帮助」看全部指令。`)
        return
      }
      await ask(msg, reply, parsed.raw)
      return
    }

    switch (command) {
      case 'ask': {
        const text = parsed.args.join(' ').trim()
        if (!text) {
          await reply('用法：「/问 <要发送给当前会话的文本>」')
          return
        }
        await ask(msg, reply, text)
        return
      }

      case 'artifacts': {
        if (!state.sessionId) {
          await reply('未绑定会话。先「/会话列表」选一个，或直接发一句话新建。')
          return
        }
        let list = []
        try {
          list = await sessions.artifacts(state.sessionId)
        } catch (error) {
          await reply(`⚠️ 读取产物失败：${error?.message ?? error}`)
          return
        }
        if (!list.length) {
          await reply('📦 这个会话还没有产出文件。（模型写文件或声明交付后会出现在这里）')
          return
        }
        const token = parsed.args[0]
        if (!token) {
          store.setChat(channelId, chatId, {
            lastArtifacts: list.map((item, i) => ({ n: i + 1, abs: item.abs, path: item.path })),
          })
          await reply(formatArtifacts(list))
          return
        }
        const pick = /^\d+$/.test(token)
          ? list[Number(token) - 1]
          : list.find((item) => item.path === token || item.abs === token)
        if (!pick) {
          await reply(`❓ 没有第 ${token} 个产物。先发「/产物」看列表。`)
          return
        }
        await sendArtifact(pick.abs, path.basename(pick.abs), reply, state)
        return
      }

      case 'sendfile': {
        const raw = parsed.args.join(' ').trim().replace(/^["']|["']$/g, '')
        if (!raw) {
          await reply('用法：「/发文件 <路径>」。相对路径按当前会话工作区解析。')
          return
        }
        const cwd = state.sessionId ? (sessions.workspaces()[0]?.path ?? process.cwd()) : process.cwd()
        const abs = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw)
        await sendArtifact(abs, path.basename(abs), reply, state)
        return
      }

      case 'help':
        await reply(HELP_TEXT)
        return

      case 'workspaces': {
        const list = sessions.workspaces()
        if (!list.length) {
          await reply('📁 还没有注册任何工作区。')
          return
        }
        const lines = ['📁 工作区']
        list.forEach((ws, i) => {
          lines.push(`  ${i + 1}  ${ws.title || ws.path}`)
          lines.push(`      ${ws.path}`)
        })
        lines.push('')
        lines.push('用「/新建 <编号或名字>」在里面开新会话')
        await reply(lines.join('\n'))
        return
      }

      // Agent Preset（模式）：只影响**之后新建**的会话。
      case 'preset': {
        const rows = await sessions.presets()
        if (!rows.length) {
          await reply('⚠️ 读不到模式列表（agentPresets 服务不可用）。')
          return
        }
        const current = state.agentPreset ?? null
        const token = parsed.argText
        if (!token) {
          await reply(formatPresets(rows, current))
          return
        }
        if (['默认', 'default', '跟随'].includes(token.toLowerCase())) {
          store.setChat(channelId, chatId, { agentPreset: null })
          await reply('✅ 已恢复跟随 Host 默认模式。')
          return
        }
        const pick = /^\d+$/.test(token)
          ? rows[Number(token) - 1]
          : rows.find((r) => r.id === token) ?? rows.find((r) => String(r.id).toLowerCase() === token.toLowerCase())
        if (!pick) {
          await reply(`❓ 没有叫「${token}」的模式。发「/模式」看编号。`)
          return
        }
        if (pick.broken) {
          await reply(`⚠️ 模式「${pick.name || pick.id}」加载失败：${pick.broken}`)
          return
        }
        store.setChat(channelId, chatId, { agentPreset: pick.id })
        await reply(`✅ 模式 → ${pick.name || pick.id}（${pick.id}）\n对之后「/新建」的会话生效。`)
        return
      }

      case 'sessions': {
        const only = parsed.argText || null
        const list = await refreshList(channelId, chatId, only)
        if (!list.groups.length) {
          await reply(`❓ 没有匹配「${only}」的工作区。发「/工作区」看列表。`)
          return
        }
        await reply(formatSessionList(list))
        return
      }

      // 历史遗留：早前用 create({cwd}) 建的会话没被挂到工作区上，会一直躺在未分组。
      // 这里把「cwd 恰好等于某个工作区目录」的会话批量补挂。
      case 'regroup': {
        const list = await sessions.listAll({ includeBlank: true, perWorkspace: 500 })
        const workspaces = sessions.workspaces()
        let moved = 0
        for (const group of list.groups) {
          if (group.title !== sessions.UNGROUPED) continue
          for (const item of group.members) {
            const owner = workspaces.find((w) => w.path === item.cwd)
            if (!owner) continue
            if (await sessions.attachToWorkspace(owner.id, item.sessionId)) moved += 1
          }
        }
        await refreshList(channelId, chatId, null)
        await reply(moved
          ? `✅ 已把 ${moved} 个会话归位到对应工作区（再发「/会话列表」看看）。`
          : '没有需要归位的会话。')
        return
      }

      case 'enter': {
        const token = parsed.args[0]
        if (!token) {
          await reply('用法：「/进入 1.2」，或直接回复编号。')
          return
        }
        await enter(channelId, chatId, token, reply)
        return
      }

      case 'current': {
        if (!state.sessionId) {
          await reply('未绑定会话。发「/会话列表」选一个，或直接发一句话新建。')
          return
        }
        await reply(await describeBinding({ n: null, sessionId: state.sessionId, title: '(当前)' }))
        return
      }

      case 'history': {
        if (!state.sessionId) {
          await reply('未绑定会话。')
          return
        }
        const count = Number(parsed.args[0]) || 10
        const messages = await sessions.history(state.sessionId, count, { includeTools: state.verbose })
        await reply(formatHistory(messages))
        return
      }

      case 'model': {
        if (!state.sessionId) {
          await reply('未绑定会话。先「/会话列表」选一个。')
          return
        }
        const catalog = await sessions.catalog()
        const current = await sessions.currentModel(state.sessionId)
        const token = parsed.args[0]
        if (!token) {
          const rendered = formatModelCatalog(catalog, current)
          await reply(rendered.text)
          return
        }
        const flat = (catalog.groups ?? []).flatMap((g) => (g.models ?? []).map((m) => ({ provider: g.id, model: m.id })))
        let pick = null
        if (/^\d+$/.test(token)) pick = flat[Number(token) - 1]
        else if (token.includes('/')) {
          const [provider, ...rest] = token.split('/')
          pick = flat.find((m) => m.provider === provider && m.model === rest.join('/'))
        }
        if (!pick) {
          await reply(`❓ 找不到模型「${token}」。先发「/模型」看编号。`)
          return
        }
        await sessions.selectModel(state.sessionId, { provider: pick.provider, model: pick.model })
        await reply(`✅ 已切换模型：${pick.provider}/${pick.model}`)
        return
      }

      case 'think': {
        if (!state.sessionId) {
          await reply('未绑定会话。')
          return
        }
        const catalog = await sessions.catalog()
        const current = await sessions.currentModel(state.sessionId)
        if (!current) {
          await reply('⚠️ 读不到当前模型，先发一轮消息再试。')
          return
        }
        const token = (parsed.args[0] ?? '').toLowerCase()
        if (!token) {
          await reply(formatEfforts(catalog, current))
          return
        }
        if (token === '默认' || token === 'default') {
          await sessions.selectModel(state.sessionId, { provider: current.provider, model: current.model })
          await reply('✅ 已恢复模型默认思考强度。')
          return
        }
        await sessions.selectModel(state.sessionId, {
          provider: current.provider,
          model: current.model,
          reasoningEffort: token,
        })
        await reply(`✅ 思考强度 → ${token}`)
        return
      }

      case 'stop': {
        if (!state.sessionId) {
          await reply('未绑定会话。')
          return
        }
        await sessions.cancel(state.sessionId)
        await reply('⏹ 已请求中断当前回合。')
        return
      }

      case 'verbose': {
        const on = (parsed.args[0] ?? 'on').toLowerCase()
        const verbose = !['off', '0', '关', '关闭'].includes(on)
        store.setChat(channelId, chatId, { verbose })
        await reply(verbose ? '🔧 已开启工具调用明细。' : '🔇 已关闭工具调用明细。')
        return
      }

      case 'new': {
        const workspaces = sessions.workspaces()
        // 允许「/新建 工作区名 模式名」：末位参数若匹配某个模式 id，就当模式用。
        let token = parsed.argText
        let explicitPreset = null
        if (parsed.args.length >= 2) {
          const last = parsed.args[parsed.args.length - 1]
          const rows = await sessions.presets()
          const hit = rows.find((r) => r.id === last || String(r.id).toLowerCase() === last.toLowerCase())
          if (hit) {
            explicitPreset = hit.id
            token = parsed.args.slice(0, -1).join(' ').trim()
          }
        }
        const preset = explicitPreset ?? state.agentPreset ?? null
        let cwd = config.defaultCwd ?? null
        if (token) {
          if (/^\d+$/.test(token)) {
            const ws = workspaces[Number(token) - 1]
            if (!ws) {
              await reply(`❓ 没有第 ${token} 个工作区：\n${workspaces.map((w, i) => `  ${i + 1}  ${w.title || w.path}`).join('\n')}`)
              return
            }
            cwd = ws.path
          } else if (path.isAbsolute(token)) {
            cwd = token
          } else {
            // 名字优先（精确 → 忽略大小写 → 包含 → 目录名包含）。
            const lower = token.toLowerCase()
            const byName = workspaces.find((w) => String(w.title || '').toLowerCase() === lower)
              ?? workspaces.find((w) => String(w.title || '').toLowerCase().includes(lower))
              ?? workspaces.find((w) => path.basename(String(w.path || '')).toLowerCase().includes(lower))
            if (byName) {
              cwd = byName.path
            } else {
              await reply([
                `❓ 没有叫「${token}」的工作区。`,
                '可选（也可以直接给绝对路径）：',
                ...workspaces.map((w, i) => `  ${i + 1}  ${w.title || w.path}`),
              ].join('\n'))
              return
            }
          }
        } else if (!cwd) {
          cwd = workspaces[0]?.path ?? null
        }
        // Session header 的 cwd 必须是绝对路径，否则 DSH 会直接抛错。
        // 宁可在这里给出可读提示，也不要把它变成一个「处理失败」。
        if (cwd && !path.isAbsolute(cwd)) {
          await reply(`❌ 工作区路径必须是绝对路径，得到的是「${cwd}」。发「/工作区」看可用项。`)
          return
        }
        let created
        try {
          created = await sessions.createSession({
            ...(cwd ? { cwd } : {}),
            ...(preset ? { agentPreset: preset } : {}),
          })
        } catch (error) {
          await reply(`❌ 新建会话失败：${error?.message ?? error}`)
          return
        }
        const ws = workspaces.find((w) => w.path === cwd)
        // 只给 cwd 不会让会话出现在工作区分组里，必须显式挂载。
        if (ws) await sessions.attachToWorkspace(ws.id, created.sessionId)
        store.bind(channelId, chatId, created.sessionId)
        const actualPreset = created.agentPreset ?? preset
        await reply([
          `🆕 已新建并进入会话${ws ? `（工作区 ${ws.title || cwd}）` : ''}`,
          `🆔 ${created.sessionId}`,
          actualPreset ? `🧩 模式 ${actualPreset}` : null,
          cwd ? `📁 ${cwd}` : null,
        ].filter(Boolean).join('\n'))
        return
      }

      case 'exit': {
        store.unbind(channelId, chatId)
        await reply('👋 已解除会话绑定（历史保留在 Harness 里）。')
        return
      }

      case 'status': {
        const list = await sessions.listAll({ includeBlank: true }).catch(() => null)
        await reply([
          '📡 dsh-im-bridge',
          `通道：${msg.channelId}`,
          `本会话绑定：${state.sessionId ?? '（无）'}`,
          `可见会话：${list ? list.total : '读取失败'}`,
          `工作区：${sessions.workspaces().length}`,
          `状态文件：${store.file}`,
        ].join('\n'))
        return
      }

      default:
        await reply(HELP_TEXT)
    }
  }

  return { handle, normalize, ALIASES }
}
