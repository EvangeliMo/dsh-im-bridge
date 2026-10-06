/**
 * 经由 GitHub REST API 推送（Git Data API）。
 *
 * ## 为什么需要它
 *
 * 某些网络环境会屏蔽 `github.com:443`（也就是 `git push` 走的那条通道），
 * 但放行 `api.github.com` 和 `codeload.github.com`。典型症状：
 *
 *   git push      → fatal: unable to access 'https://github.com/...':
 *                   Recv failure: Connection was reset
 *   api.github.com → 正常
 *
 * 这种情况下 `git push` 永远失败，但用 Git Data API 手工搭
 * blob → tree → commit → ref，效果等同于一次 push。
 *
 * ## 用法
 *
 *   # token 从环境变量读，绝不落盘、不打印
 *   $env:GH_TOKEN = "<有 repo 权限的 token>"
 *   node scripts/push-via-api.mjs "feat: 描述"
 *
 * 可用环境变量：
 *   GH_OWNER  默认 EvangeliMo
 *   GH_REPO   默认 dsh-im-bridge
 *   GH_BRANCH 默认 main
 *
 * ## 注意
 *
 * - **会整棵树覆盖**：脚本按工作目录内容建 tree，所以本地没提交的东西也会被推上去。
 *   推送前先跑 `npm run audit` 确认没有凭据混进去。
 * - 脚本自己（`scripts/` 下划线开头的文件）和 `.gitignore` 里那几类文件会被跳过。
 * - `GH_TOKEN` 用完建议立刻吊销。
 */
import fs from 'node:fs'
import path from 'node:path'

const token = process.env.GH_TOKEN
if (!token) {
  console.error('缺少 GH_TOKEN 环境变量（需要一个有 repo 权限的 GitHub token）')
  process.exit(1)
}

const OWNER = process.env.GH_OWNER ?? 'EvangeliMo'
const REPO = process.env.GH_REPO ?? 'dsh-im-bridge'
const BRANCH = process.env.GH_BRANCH ?? 'main'
const ROOT = path.resolve(import.meta.dirname, '..')
const MESSAGE = process.argv.slice(2).join(' ').trim() || `chore: 同步于 ${new Date().toISOString()}`

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'dsh-im-bridge-publisher',
  'Content-Type': 'application/json',
}

async function api(endpoint, init = {}) {
  const response = await fetch(`https://api.github.com${endpoint}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } })
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = { raw: text.slice(0, 300) }
  }
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${endpoint} -> HTTP ${response.status}: ${JSON.stringify(body).slice(0, 400)}`)
  }
  return body
}

// ---------------------------------------------------------------- 收集文件
const SKIP_DIRS = new Set(['.git', 'node_modules'])
const SKIP_FILE = /(^|\/)(im_bridge_(creds|state|status)\.json|im_bridge_media\.log|im_bridge_qr\.(txt|html)|.*\.log|.*\.tmp|.*\.bak|\.env.*)$/
const SKIP_PREFIX = /(^|\/)_backup_/
/** 下划线开头的脚本是临时工具，不进仓库 */
const SKIP_TEMP_SCRIPT = /^scripts\/_.*$/

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    const rel = path.relative(ROOT, full).replace(/\\/g, '/')
    if (entry.isDirectory()) {
      if (SKIP_PREFIX.test(rel)) continue
      yield* walk(full)
    } else if (entry.isFile()) {
      if (SKIP_FILE.test(rel) || SKIP_PREFIX.test(rel) || SKIP_TEMP_SCRIPT.test(rel)) continue
      yield rel
    }
  }
}

const files = [...walk(ROOT)].sort()
console.log(`准备推送 ${files.length} 个文件 → ${OWNER}/${REPO}#${BRANCH}`)

// ------------------------------------------------- 0. 空仓库引导
// Git Data API 在没有任何 commit 的仓库上会 409 "Git Repository is empty"，
// 所以先用 Contents API 落一个初始 commit 拿到 parent。
const refPath = `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`
const readRef = () => fetch(`https://api.github.com${refPath}`, { headers })
let headResponse = await readRef()
if (!headResponse.ok) {
  console.log('  仓库为空，先用 Contents API 建立初始 commit…')
  const seed = await api(`/repos/${OWNER}/${REPO}/contents/README.md`, {
    method: 'PUT',
    body: JSON.stringify({ message: 'chore: 初始化仓库', content: Buffer.from('# dsh-im-bridge\n', 'utf8').toString('base64') }),
  })
  console.log(`  初始 commit: ${seed.commit.sha}`)
  headResponse = await readRef()
}
const parentSha = (await headResponse.json())?.object?.sha
if (!parentSha) throw new Error('拿不到父 commit')
console.log(`  父提交: ${parentSha}`)

// ------------------------------------------------- 1. blobs
const tree = []
for (const [index, rel] of files.entries()) {
  const content = fs.readFileSync(path.join(ROOT, rel))
  const blob = await api(`/repos/${OWNER}/${REPO}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({ content: content.toString('base64'), encoding: 'base64' }),
  })
  tree.push({ path: rel, mode: '100644', type: 'blob', sha: blob.sha })
  process.stdout.write(`\r  blob ${index + 1}/${files.length}`)
}
console.log(`\n  已上传 ${tree.length} 个 blob`)

// ------------------------------------------------- 2. tree → commit → ref
const treeResult = await api(`/repos/${OWNER}/${REPO}/git/trees`, {
  method: 'POST',
  body: JSON.stringify({ tree }),
})
const commit = await api(`/repos/${OWNER}/${REPO}/git/commits`, {
  method: 'POST',
  body: JSON.stringify({ message: MESSAGE, tree: treeResult.sha, parents: [parentSha] }),
})
await api(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
  method: 'PATCH',
  body: JSON.stringify({ sha: commit.sha, force: false }),
})

console.log(`  tree:   ${treeResult.sha}`)
console.log(`  commit: ${commit.sha}`)
console.log(`\n完成：https://github.com/${OWNER}/${REPO}`)
process.exit(0)
