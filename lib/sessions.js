/**
 * Thin, single-place adapter over the Host services the bridge depends on.
 *
 * Everything the bridge knows about Harness sessions goes through this module.
 * That keeps a future DSH upgrade to one file: if a service signature drifts,
 * it breaks here, not scattered across channels and the router.
 *
 * Services (all verified against the live Host via the Inspect provider):
 *   ctx.sessionController  list / prompt / cancel / page / selectModel /
 *                          modelCatalog / create / inspect
 *   ctx.sessionQuery       listSessions / listEvents / readSession /
 *                          readTitleSnapshots
 *   ctx.workspaceRegistry  list() -> Workspace[] (authoritative sessionIds)
 */
import { collectArtifacts } from './artifacts.js'

const UNGROUPED = '未分组'

/** Extract the visible plain text of one message-shaped object. */
function blocksToText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function createSessions(ctx, log = console) {
  // Hard dependencies come through `inject`; the optional ones are read with
  // ctx.get() so a Host without them still loads the plugin.
  const controller = ctx.get('sessionController')
  const query = ctx.get('sessionQuery')
  const registry = ctx.get('workspaceRegistry')
  const timeZone = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone
    } catch {
      return undefined
    }
  })()

  if (!controller || !query) {
    throw new Error('[im-bridge] sessionController / sessionQuery 不可用，插件无法工作')
  }

  /** Titles for many sessions in one round-trip; failures stay isolated. */
  async function titlesOf(sessionIds) {
    if (!sessionIds.length) return new Map()
    const map = new Map()
    try {
      const results = await query.readTitleSnapshots(sessionIds, new AbortController().signal)
      for (const result of results ?? []) {
        if (result?.status === 'fulfilled') {
          const title = result.value?.title?.title
          if (title) map.set(result.sessionId, title)
        }
      }
    } catch (error) {
      log.warn?.(`[im-bridge] 读取标题失败: ${error?.message ?? error}`)
    }
    return map
  }

  /**
   * Every visible session, grouped the same way the web sidebar groups them:
   * by the workspace that claims it (Workspace.sessionIds is authoritative),
   * with anything unclaimed landing in 未分组. Numbering is `<workspace>.<n>`.
   */
  async function listAll({ includeBlank = false, perWorkspace = 15, onlyWorkspace } = {}) {
    const value = await controller.list({}, new AbortController().signal)
    const summaries = (value?.items ?? []).filter((s) => {
      if (s.origin === 'subagent') return false
      if (!includeBlank && s.blank) return false
      return true
    })

    const workspaces = registry?.list?.() ?? []
    const titleMap = await titlesOf(summaries.map((s) => s.sessionId))

    const claimed = new Set()
    const rawGroups = []

    for (const workspace of workspaces) {
      const owned = new Set(workspace.sessionIds ?? [])
      const members = summaries.filter((s) => owned.has(s.sessionId))
      if (!members.length) continue
      for (const m of members) claimed.add(m.sessionId)
      rawGroups.push({ title: workspace.title || workspace.path, path: workspace.path, members })
    }

    const rest = summaries.filter((s) => !claimed.has(s.sessionId))
    if (rest.length) rawGroups.push({ title: UNGROUPED, path: null, members: rest })

    // 只看某个工作区时（onlyWorkspace = 序号或名字），其余分组直接丢掉。
    const wanted = onlyWorkspace == null ? null : String(onlyWorkspace).trim().toLowerCase()
    const selected = wanted == null ? rawGroups : rawGroups.filter((group, gi) => (
      String(gi + 1) === wanted || String(group.title).toLowerCase() === wanted
    ))

    const groups = []
    const flat = []
    let total = 0
    let hidden = 0
    selected.forEach((group) => {
      const gi = rawGroups.indexOf(group)
      const sorted = [...group.members].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      // 手机上看不了几十条；超出部分只计数不上屏。
      const cap = wanted == null ? perWorkspace : Math.max(perWorkspace, 60)
      hidden += Math.max(0, sorted.length - cap)
      const members = sorted.slice(0, cap).map((s, si) => {
        const n = `${gi + 1}.${si + 1}`
        const item = {
          n,
          sessionId: s.sessionId,
          title: titleMap.get(s.sessionId) || '(未命名)',
          updatedAt: s.updatedAt,
          running: !!s.running,
          cwd: s.cwd,
          workspaceTitle: group.title,
        }
        flat.push(item)
        total += 1
        return item
      })
      if (members.length) groups.push({ index: gi + 1, title: group.title, path: group.path, members })
    })

    return { groups, flat, total, hidden }
  }

  function resolve(list, token) {
    const raw = String(token ?? '').trim()
    if (!raw) return undefined
    const direct = list.flat.find((item) => item.n === raw)
    if (direct) return direct
    if (/^\d+$/.test(raw)) {
      const byIndex = list.flat[Number(raw) - 1]
      if (byIndex) return byIndex
    }
    return list.flat.find((item) => item.sessionId === raw)
  }

  /** Full validated event log (cold-safe) for one session. */
  async function readLog(sessionId) {
    return await query.readSession(sessionId)
  }

  /** Flatten raw events into chat-shaped messages. */
  function toMessages(events) {
    const out = []
    for (const event of events ?? []) {
      const data = event?.data
      if (event.type === 'user/message') {
        const text = blocksToText(data?.content)
        if (text) out.push({ role: 'user', text, seq: event.seq, time: event.time })
      } else if (event.type === 'assistant/message') {
        const text = blocksToText(data?.message?.content)
        if (text) out.push({ role: 'assistant', text, seq: event.seq, time: event.time })
        for (const block of data?.message?.content ?? []) {
          if (block?.type === 'tool-call') {
            out.push({ role: 'tool', text: `${block.name} ${oneLineArgs(block.arguments)}`, seq: event.seq, time: event.time })
          }
        }
      } else if (event.type === 'tool/call') {
        out.push({ role: 'tool', text: `${data?.name} ${oneLineArgs(data?.arguments)}`, seq: event.seq, time: event.time })
      }
    }
    return out
  }

  function oneLineArgs(args) {
    if (typeof args !== 'string' || !args) return ''
    return args.length > 120 ? `${args.slice(0, 120)}…` : args
  }

  async function history(sessionId, count = 10, { includeTools = false } = {}) {
    const { events } = await readLog(sessionId)
    let messages = toMessages(events)
    if (!includeTools) messages = messages.filter((m) => m.role !== 'tool')
    return messages.slice(-Math.max(1, Math.min(count, 50)))
  }

  /** Highest committed seq, used as the "before I asked" watermark. */
  async function lastSeq(sessionId) {
    const records = await query.listEvents(sessionId)
    let max = 0
    for (const record of records ?? []) max = Math.max(max, record.seq ?? 0)
    return max
  }

  async function prompt(sessionId, content) {
    const requestId = `im-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    // 允许传字符串（纯文本）或已组装好的 content parts（含图片/文件附件）。
    const parts = Array.isArray(content)
      ? content
      : [{ type: 'text', text: String(content ?? '') }]
    // prompt 的第二个参数 signal 是**必填**：Host 实现会直接调用
    // signal.throwIfAborted()，漏传会炸成
    // "Cannot read properties of undefined (reading 'throwIfAborted')"。
    await controller.prompt({
      requestId,
      sessionId,
      mode: 'queue',
      content: parts,
      ...(timeZone ? { clientTimeZone: timeZone } : {}),
    }, new AbortController().signal)
    return requestId
  }

  /**
   * Wait until the turn started by our prompt closes.
   * Polling the lightweight event index is far simpler than holding a
   * follow() stream open per chat, and is robust across reconnects.
   */
  async function waitForTurn(sessionId, afterSeq, { timeoutMs = 15 * 60_000, intervalMs = 1200, signal } = {}) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (signal?.aborted) return { ok: false, reason: 'aborted' }
      const records = await query.listEvents(sessionId)
      const done = (records ?? []).find((r) => r.type === 'turn/end' && (r.seq ?? 0) > afterSeq)
      if (done) return { ok: true, endSeq: done.seq }
      await sleep(intervalMs)
    }
    return { ok: false, reason: 'timeout' }
  }

  /** The assistant's final text for the turn that ended after `afterSeq`. */
  async function lastAnswer(sessionId, afterSeq) {
    const { events } = await readLog(sessionId)
    const fresh = (events ?? []).filter((e) => (e.seq ?? 0) > afterSeq)
    let text = ''
    for (const event of fresh) {
      if (event.type !== 'assistant/message') continue
      const body = blocksToText(event.data?.message?.content)
      if (body) text = body
    }
    return text
  }

  async function cancel(sessionId) {
    return await controller.cancel({ sessionId })
  }

  async function catalog() {
    return await controller.modelCatalog()
  }

  async function selectModel(sessionId, selection) {
    return await controller.selectModel({ sessionId, ...selection })
  }

  /** Effective model / reasoning effort of a session, from its own log. */
  async function currentModel(sessionId) {
    try {
      const { events } = await readLog(sessionId)
      let context = null
      let headerConfig = null
      for (const event of events ?? []) {
        if (event.type === 'request/context') {
          context = { provider: event.data?.provider, model: event.data?.model, contextWindow: event.data?.contextWindow }
        } else if (event.type === 'request/header') {
          const config = event.data?.header?.config
          if (config) headerConfig = config
        }
      }
      if (!context && !headerConfig) return null
      return { ...(context ?? {}), ...(headerConfig ?? {}) }
    } catch {
      return null
    }
  }

  async function createSession({ cwd, workspaceId, agentPreset } = {}) {
    return await controller.create({
      ...(cwd ? { cwd } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(agentPreset ? { agentPreset } : {}),
    })
  }

  /** 当前该会话实际使用的模式（取日志里最后一次 agent-preset/selected）。 */
  async function currentPreset(sessionId) {
    try {
      const { events } = await readLog(sessionId)
      let preset = null
      for (const event of events ?? []) {
        if (event.type === 'agent-preset/selected' && event.data?.agentPreset) {
          preset = event.data.agentPreset
        }
      }
      return preset
    } catch {
      return null
    }
  }

  /**
   * 可选的 Agent Preset（模式）清单。
   * 优先用 remoteExportList()，它给的正是 {id, isDefault, name, description, broken}。
   */
  async function presets() {
    const service = ctx.get('agentPresets')
    if (!service) return []
    try {
      if (typeof service.remoteExportList === 'function') {
        const roster = await service.remoteExportList()
        if (roster?.presets?.length) return [...roster.presets]
      }
      const list = (await service.list?.()) ?? []
      return list.map((p) => ({
        id: p?.id ?? p?.agentPreset ?? p?.meta?.id,
        isDefault: !!(p?.isDefault ?? p?.meta?.isDefault),
        name: p?.name ?? p?.meta?.name,
        description: p?.description ?? p?.meta?.description,
        broken: p?.broken ?? p?.failure,
      })).filter((p) => p.id)
    } catch (error) {
      log.warn?.(`[im-bridge] 读取模式列表失败: ${error?.message ?? error}`)
      return []
    }
  }

  function workspaces() {
    return registry?.list?.() ?? []
  }

  /** 会话产出的文件（交付声明 + 写文件类工具），带绝对路径。 */
  async function artifacts(sessionId) {
    const { session, events } = await readLog(sessionId)
    // 相对路径必须按会话自己的工作区解析；拿不到就退到第一个工作区，
    // 绝不能用进程 cwd（那是 DSH 安装目录，会解析出错误的绝对路径）。
    const cwd = session?.cwd || workspaces()[0]?.path
    return collectArtifacts(events, { cwd })
  }

  /** 该会话允许发送的根目录：自己的 cwd 加上所有已注册工作区。 */
  function allowedRoots(sessionId, cwd) {
    const roots = new Set()
    if (cwd) roots.add(cwd)
    for (const ws of workspaces()) if (ws?.path) roots.add(ws.path)
    return [...roots]
  }

  /**
   * 把会话挂到工作区上。
   *
   * `sessionController.create({ cwd })` 只写会话头里的 cwd；工作区分组用的是
   * `Workspace.sessionIds`，它是「已 attach ∩ cwd 匹配」的交集。少了这一步，
   * 新建的会话会掉进「未分组」，即使 cwd 就是工作区目录。
   */
  async function attachToWorkspace(workspaceId, sessionId) {
    if (!workspaceId || !sessionId) return false
    const workspace = registry?.get?.(workspaceId)
    if (!workspace?.attachSession) return false
    try {
      await workspace.attachSession(sessionId)
      return true
    } catch (error) {
      log.warn?.(`[im-bridge] 挂载会话到工作区失败: ${error?.message ?? error}`)
      return false
    }
  }

  return {
    listAll,
    resolve,
    readLog,
    toMessages,
    history,
    lastSeq,
    prompt,
    waitForTurn,
    lastAnswer,
    cancel,
    catalog,
    selectModel,
    currentModel,
    createSession,
    currentPreset,
    presets,
    workspaces,
    attachToWorkspace,
    artifacts,
    allowedRoots,
    UNGROUPED,
  }
}
