/**
 * 推送前的密钥审计：确认本机的凭据 / 会话标识没有出现在任何将要提交的文件里。
 *
 * 这是给**贡献者**用的守卫 —— 你自己的 appId / appSecret / bot token / openid
 * 都存在 %DSH_HOME%\storages\ 下、本来就不该进仓库。这个脚本把它们全部读出来，
 * 逐个在仓库文件里搜一遍（含 base64/大小写变形），只报告"哪个文件的哪一行命中了
 * 哪个字段名"，**绝不打印密钥本身**。
 *
 *   node scripts/audit-secrets.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const SELF = path.relative(ROOT, import.meta.filename).replace(/\\/g, '/')

/** 公开的官方端点，出现在文档/源码里是正常且必要的。 */
const PUBLIC_VALUES = new Set([
  'https://ilinkai.weixin.qq.com',
  'https://novac2c.cdn.weixin.qq.com',
  'https://api.bot.qq.com',
  'https://multimedia.nt.qq.com.cn',
  'https://grouptalk.c2c.qq.com',
  'https://cdn.example.com',
])

/** 从本机 DSH 状态里收集所有"不该进仓库"的值。 */
function collectLocalValues() {
  const out = []
  const push = (field, value) => {
    if (typeof value === 'string' && value.trim().length >= 8 && !PUBLIC_VALUES.has(value.trim())) {
      out.push({ field, value: value.trim() })
    }
  }
  const walkObject = (node, prefix) => {
    for (const [key, value] of Object.entries(node ?? {})) {
      if (value && typeof value === 'object') walkObject(value, `${prefix}${key}.`)
      else push(`${prefix}${key}`, value)
    }
  }

  const files = [
    ['creds', path.join(HOME, 'storages', 'im_bridge_creds.json')],
  ]
  for (const [label, file] of files) {
    try {
      walkObject(JSON.parse(fs.readFileSync(file, 'utf8')), `${label}.`)
    } catch {
      /* 文件不存在或不是 JSON，跳过 */
    }
  }

  // 会话状态里只取**聊天标识**（key 形如 `qq:<openid>` / `wechat:<ilink id>`）
  // 以及 sessionId；lastArtifacts 里是本地文件路径，属于另一类检查（见下）。
  try {
    const state = JSON.parse(fs.readFileSync(path.join(HOME, 'storages', 'im_bridge_state.json'), 'utf8'))
    for (const [key, chat] of Object.entries(state?.chats ?? {})) {
      const [, chatId] = key.split(':')
      push(`state.chatId`, chatId)
      push(`state.sessionId`, chat?.sessionId)
    }
  } catch {
    /* 跳过 */
  }

  return out
}

/** 本机绝对路径：不是密钥，但公开仓库里不该出现（泄露用户名、对别人也无用）。 */
const LOCAL_PATH_PATTERNS = [
  { field: '(Windows 用户目录)', re: /[A-Za-z]:\\Users\\[^\\\s"']+/g },
  { field: '(本机 Documents 路径)', re: /[A-Za-z]:\\[^\\\s"']*\\Documents\\[^\\\s"']*/g },
  { field: '(Unix 家目录)', re: /\/(?:home|Users)\/[a-z0-9_-]+\//gi },
]

/** 形如 `<你的路径>` / `%USERPROFILE%` / 含中文说明的，是文档占位符，不算泄露。 */
function isPlaceholderPath(sample) {
  return /[<>%]/.test(sample) || /[^\x00-\x7F]/.test(sample)
}

/** 待提交的文件（排除 node_modules / .git / 本脚本自己）。 */
function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.isFile()) yield full
  }
}

/** 每个值的所有可能写法：原样、大小写、以及 base64 编码后的形态。 */
function variantsOf(value) {
  const set = new Set([value, value.toLowerCase(), value.toUpperCase()])
  try {
    set.add(Buffer.from(value, 'utf8').toString('base64'))
  } catch {
    /* ignore */
  }
  return [...set].filter((item) => item.length >= 8)
}

const values = collectLocalValues()
const findings = []
let scanned = 0

for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/')
  if (rel === SELF) continue
  let text
  try {
    text = fs.readFileSync(file, 'latin1')
  } catch {
    continue
  }
  scanned += 1
  for (const { field, value } of values) {
    for (const variant of variantsOf(value)) {
      const index = text.indexOf(variant)
      if (index === -1) continue
      findings.push({ rel, line: text.slice(0, index).split('\n').length, field })
      break
    }
  }
  // 本机绝对路径：公开仓库里不该出现
  for (const { field, re } of LOCAL_PATH_PATTERNS) {
    re.lastIndex = 0
    let match
    while ((match = re.exec(text)) !== null) {
      if (isPlaceholderPath(match[0])) continue
      findings.push({ rel, line: text.slice(0, match.index).split('\n').length, field, sample: match[0] })
      break
    }
  }
}

console.log(`扫描 ${scanned} 个文件（已排除 node_modules / .git / 本脚本）`)
console.log(`从本机 DSH 状态取到 ${values.length} 个敏感值（${[...new Set(values.map((v) => v.field.split('.')[0]))].join(', ')}）\n`)

if (findings.length === 0) {
  console.log('✅ 干净：没有本地凭据 / 会话标识 / 本机绝对路径出现在待提交文件中')
} else {
  console.log(`❌ 发现 ${findings.length} 处命中，提交前请先处理：`)
  for (const finding of findings) {
    const sample = finding.sample ? `   例：${finding.sample}` : ''
    console.log(`   ${finding.rel}:${finding.line}  →  ${finding.field}${sample}`)
  }
  process.exitCode = 1
}
