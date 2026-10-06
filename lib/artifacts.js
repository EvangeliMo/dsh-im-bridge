/**
 * 会话产物（artifact）收集。
 *
 * 两类来源：
 *  1. `deliverables/presented` 事件 —— 模型显式声明交付的文件，最权威；
 *  2. 写文件类工具的 `tool/call` —— 从 arguments 里取 file_path/path。
 *
 * 只做「路径 → 绝对路径」的归并，不读文件内容；真正的发送由 channel 负责。
 */
import path from 'node:path'

/** 会写出文件的工具名（不同预设可能不同，宁可多列）。 */
const FILE_TOOLS = new Set([
  'write',
  'write_file',
  'edit',
  'edit_file',
  'multi_edit',
  'apply_patch',
  'create_file',
  'str_replace_editor',
  'notebook_edit',
  'save_file',
])

function pathFromArgs(args) {
  if (typeof args !== 'string' || !args.trim()) return null
  let parsed
  try {
    parsed = JSON.parse(args)
  } catch {
    // 参数可能是被截断的流式片段，退化为正则捞路径。
    const m = /"(?:file_path|path|filePath|filename)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(args)
    return m ? m[1].replace(/\\\\/g, '\\') : null
  }
  const value = parsed?.file_path ?? parsed?.path ?? parsed?.filePath ?? parsed?.filename
  return typeof value === 'string' && value.trim() ? value : null
}

/**
 * @returns {Array<{ path:string, abs:string, kind:string, description?:string, seq:number, time:number }>}
 */
export function collectArtifacts(events, { cwd } = {}) {
  const found = new Map()
  for (const event of events ?? []) {
    if (event.type === 'deliverables/presented') {
      for (const file of event.data?.files ?? []) {
        if (!file?.path) continue
        found.set(file.path, {
          path: file.path,
          kind: 'deliverable',
          description: file.description,
          seq: event.seq,
          time: event.time,
        })
      }
    } else if (event.type === 'tool/call' && FILE_TOOLS.has(event.data?.name)) {
      const raw = pathFromArgs(event.data?.arguments)
      if (!raw) continue
      found.set(raw, { path: raw, kind: event.data.name, seq: event.seq, time: event.time })
    }
  }
  // 同一个文件可能既被声明为交付、又被写工具记到，按**绝对路径**归并。
  const byAbs = new Map()
  for (const item of found.values()) {
    const abs = path.isAbsolute(item.path) ? item.path : path.resolve(cwd || process.cwd(), item.path)
    const prev = byAbs.get(abs)
    if (!prev) {
      byAbs.set(abs, { ...item, abs })
      continue
    }
    const merged = { ...item, abs }
    if (prev.kind === 'deliverable') {
      merged.kind = 'deliverable'
      merged.description = prev.description ?? merged.description
      merged.path = prev.path
    }
    byAbs.set(abs, merged)
  }
  return [...byAbs.values()].sort((a, b) => a.seq - b.seq)
}

/** 只允许发送会话工作区内的文件（防把任意系统文件传出 IM）。 */
export function isInsideAny(target, roots) {
  const resolved = path.resolve(target)
  return (roots ?? []).some((root) => {
    if (!root) return false
    const base = path.resolve(root)
    const rel = path.relative(base, resolved)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  })
}
