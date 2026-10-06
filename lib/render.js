/**
 * Pure text rendering helpers for chat channels.
 *
 * Chat bubbles are not Markdown renderers: everything here exists to turn
 * Harness output into something that reads well in WeChat / QQ, and to obey
 * their practical message-length limits.
 */

/** Chat platforms dislike huge single messages; 900 chars is safely under
 *  both WeChat's and QQ's practical limits and keeps part numbering readable. */
export const CHUNK_LIMIT = 900

/** Collapse a possibly multi-line string into one bounded line. */
export function oneLine(text, max = 60) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max - 1)}…`
}

/** Strip the Markdown that chat clients would otherwise show literally. */
export function stripMarkdown(text) {
  return String(text ?? '')
    .replace(/```[a-zA-Z0-9_-]*\n?/g, '\n')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '· ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function formatClock(ts) {
  if (!ts) return '--'
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * Split `text` into chunks of at most `limit` characters, preferring line
 * boundaries. Returns `['(1/3) …', '(2/3) …', …]` when more than one chunk.
 */
export function chunkText(text, limit = CHUNK_LIMIT) {
  const body = String(text ?? '').trim()
  if (!body) return []
  if (body.length <= limit) return [body]

  const chunks = []
  let rest = body
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit)
    if (cut < limit * 0.5) cut = limit
    chunks.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest) chunks.push(rest)
  return chunks.map((part, i) => `(${i + 1}/${chunks.length}) ${part}`)
}

/** Render `listAll()` output as the numbered session list. */
export function formatSessionList(list) {
  if (!list.groups.length) {
    return '📭 当前没有可用会话。\n直接发一句话，我可以帮你在默认工作区开一个新的。'
  }
  const lines = []
  for (const group of list.groups) {
    lines.push(`📁 ${group.title}  (${group.members.length})`)
    for (const item of group.members) {
      const flags = item.running ? '▶ ' : ''
      lines.push(`  ${item.n}  ${flags}${oneLine(item.title, 34)}   ${formatClock(item.updatedAt)}`)
    }
  }
  lines.push('')
  lines.push(`共 ${list.total} 个会话 · 回复编号进入（如 ${list.groups[0].members[0].n}）`)
  if (list.hidden) {
    lines.push(`（每个工作区只显示最近若干条，另有 ${list.hidden} 个未列出：/会话列表 <工作区名> 看全部）`)
  }
  return lines.join('\n')
}

/** Render a conversation history slice. */
export function formatHistory(messages, { title } = {}) {
  if (!messages.length) return '📭 这个会话还没有消息。'
  const lines = [title ? `🕘 ${title}（最近 ${messages.length} 条）` : `🕘 最近 ${messages.length} 条`]
  for (const m of messages) {
    const who = m.role === 'user' ? '🧑' : m.role === 'assistant' ? '🤖' : '🔧'
    const body = oneLine(stripMarkdown(m.text), 220)
    if (!body) continue
    lines.push(`${who} ${body}`)
  }
  return lines.join('\n')
}

/** Render the grouped model catalog with numbers for `/模型 <n>`. */
export function formatModelCatalog(catalog, current) {
  const lines = []
  let n = 0
  const index = []
  for (const group of catalog.groups ?? []) {
    const rows = []
    for (const model of group.models ?? []) {
      n += 1
      index.push({ n, provider: group.id, model: model.id, name: model.name })
      const star = current && current.provider === group.id && current.model === model.id ? ' ⭐' : ''
      rows.push(`  ${n}  ${oneLine(model.name || model.id, 40)}${star}`)
    }
    if (rows.length) lines.push(`🏷️ ${group.name || group.id}`, ...rows)
  }
  if (!lines.length) return '⚠️ 当前没有可选模型。'
  lines.push('')
  lines.push('回复「/模型 编号」切换；已选中的模型标 ⭐')
  return { text: lines.join('\n'), index }
}

/** Render model reasoning-effort choices. */
export function formatEfforts(catalog, current) {
  const entry = (catalog.groups ?? [])
    .flatMap((g) => (g.models ?? []).map((m) => ({ provider: g.id, model: m.id, reasoning: m.reasoning })))
    .find((m) => current && m.provider === current.provider && m.model === current.model)
  const efforts = entry?.reasoning?.efforts ?? []
  if (!efforts.length) return '⚠️ 当前模型不支持思考强度设置。'
  const lines = ['🧠 可选思考强度：']
  for (const e of efforts) {
    const star = current?.reasoningEffort === e.id ? ' ⭐' : ''
    lines.push(`  ${e.id}  ${oneLine(e.name || '', 30)}${star}`)
  }
  const def = entry?.reasoning?.defaultEffort
  if (def) lines.push(`（模型默认：${def}）`)
  lines.push('回复「/思考 <档位>」切换，或「/思考 默认」恢复默认')
  return lines.join('\n')
}

export const HELP_TEXT = [
  '🤖 DeepSeek Harness 遥控指令',
  '',
  '/会话列表      按工作区列出会话并编号',
  '/会话列表 <工作区>  只看某个工作区的全部会话',
  '1.2           直接回复编号进入该会话',
  '/工作区        列出工作区（编号 + 路径）',
  '/归位          把落在未分组、但属于某工作区的会话归位',
  '/模式          列出可选模式（Agent Preset）',
  '/模式 <编号>   切换模式（对之后新建的会话生效）',
  '/当前          当前绑定的会话',
  '/历史 [n]      最近 n 条消息（默认 10）',
  '/模型          列出可选模型',
  '/模型 <编号>   切换模型',
  '/思考 <档位>   切换思考强度',
  '/产物          列出本会话产出的文件',
  '/产物 <编号>   把该文件发到当前聊天',
  '/发文件 <路径> 直接发送一个文件',
  '/停止          中断当前回合',
  '/新建 <工作区> 新建会话并进入（可写工作区名字或编号）',
  '/退出          解除当前会话绑定',
  '/状态          桥接运行状态',
  '/帮助          这条帮助',
  '',
  '直接发一句话 = 发给当前会话（未绑定时自动新建）',
  '纯数字文本请用「/问 3.1」发送，避免被当成编号',
].join('\n')

export function formatBind(binding) {
  return [
    `✅ 已进入会话 ${binding.n ?? ''}`.trim(),
    `📁 ${binding.workspaceTitle ?? '未分组'}`,
    `📝 ${oneLine(binding.title, 40)}`,
    `🆔 ${binding.sessionId}`,
    binding.preset ? `🧩 模式 ${binding.preset}` : null,
    binding.model ? `🧠 ${binding.model.provider}/${binding.model.model}${binding.model.reasoningEffort ? ` · ${binding.model.reasoningEffort}` : ''}` : null,
    binding.recent?.length ? `\n${formatHistory(binding.recent)}` : null,
  ].filter(Boolean).join('\n')
}

/**
 * Render the Agent Preset roster for `/模式`.
 * `current` is the chat's chosen preset id (null = follow the Host default).
 */
export function formatPresets(rows, current) {
  if (!rows.length) return '⚠️ 读不到模式列表（agentPresets 服务不可用）。'
  const lines = ['🧩 可选模式（Agent Preset）']
  rows.forEach((row, i) => {
    const marks = []
    if (row.isDefault) marks.push('Host 默认')
    if (current && current === row.id) marks.push('本聊天已选')
    const suffix = marks.length ? `  [${marks.join(' · ')}]` : ''
    const broken = row.broken ? '  ⚠️ 加载失败' : ''
    lines.push(`  ${i + 1}  ${oneLine(row.name || row.id, 28)}  (${row.id})${suffix}${broken}`)
  })
  lines.push('')
  if (current) lines.push(`当前本聊天：${current}（发「/模式 默认」恢复跟随 Host 默认）`)
  else lines.push('当前：跟随 Host 默认（标注的那一项）')
  lines.push('模式对**之后新建**的会话生效：先「/模式 2」，再「/新建 工作区名」')
  return lines.join('\n')
}

/** Render the artifact list for `/产物`. */
export function formatArtifacts(list) {
  const lines = [`📦 本会话产出 ${list.length} 个文件`]
  list.forEach((item, i) => {
    const size = item.bytes != null ? `  ${(item.bytes / 1024).toFixed(0)}KB` : ''
    lines.push(`  ${i + 1}  ${oneLine(item.path, 44)}${size}`)
  })
  lines.push('')
  lines.push('回复「/产物 <编号>」把文件发到这里')
  return lines.join('\n')
}
