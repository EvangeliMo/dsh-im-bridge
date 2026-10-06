/**
 * QQ 富媒体上传的离线测试：把 fetch 换成 stub，逐步验证
 *
 *   token → upload_prepare → 逐片 PUT → upload_part_finish → /files → 发消息
 *
 * 重点覆盖线上踩到的那次失败：`upload_part_finish` 返回 40093001
 * （官方文案就是"请重试"）时，必须重试并且最终成功。
 *
 *   node scripts/test-qq-upload.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-im-qq-upload-'))

function assert(condition, label) {
  if (condition) console.log(`  ✅ ${label}`)
  else {
    console.error(`  ❌ ${label}`)
    process.exitCode = 1
  }
}

const FILE = path.join(tmp, 'report.txt')
const CONTENT = 'x'.repeat(300) // 小文件：服务端会给 1 个分片
fs.writeFileSync(FILE, CONTENT, 'utf8')

/** 记录每一次请求，供断言检查。 */
function makeStub({ failFinishTimes = 0, failPut = false, parts = 1, blockSize = 5 * 1024 * 1024, partIndexBase = 0 } = {}) {
  const log = []
  let finishAttempts = 0

  const stub = async (url, options = {}) => {
    const method = options?.method ?? 'GET'
    const body = options?.body && typeof options.body === 'string' ? JSON.parse(options.body) : undefined
    log.push({ url, method, body, bytes: options?.body?.length })

    const json = (value, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      async text() { return JSON.stringify(value) },
      async json() { return value },
    })

    if (url.includes('/app/getAppAccessToken')) {
      return json({ access_token: 'stub-token', expires_in: '7200' })
    }
    if (url.includes('/upload_prepare')) {
      return json({
        upload_id: 'upload_stub',
        block_size: String(blockSize),
        parts: Array.from({ length: parts }, (_, i) => ({
          index: i + partIndexBase,
          presigned_url: `https://cos.example.com/part/${i}`,
          block_size: String(blockSize),
        })),
        upload_config: { concurrency: 1, retry_timeout: 300, retry_delay: 1 },
      })
    }
    if (url.startsWith('https://cos.example.com/')) {
      if (failPut) {
        return { ok: false, status: 403, headers: { get: () => null }, async text() { return 'SignatureDoesNotMatch' } }
      }
      // 像真实 CDN 那样回一个「所发内容 MD5」的 ETag
      const etag = `"${createHash('md5').update(options?.body ?? Buffer.alloc(0)).digest('hex')}"`
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (name.toLowerCase() === 'etag' ? etag : null) },
        async text() { return '' },
      }
    }
    if (url.includes('/upload_part_finish')) {
      finishAttempts += 1
      if (finishAttempts <= failFinishTimes) {
        return json({ message: '文件上传失败，请重试', code: 40093001, err_code: 40093001, trace_id: 'stub-trace' }, 400)
      }
      return json({})
    }
    if (url.includes('/files')) {
      return json({ file_uuid: 'uuid_stub', file_info: 'FILE_INFO_STUB', ttl: 300 })
    }
    if (url.includes('/messages')) {
      return json({ id: 'msg_stub' })
    }
    return json({ message: `unexpected ${url}` }, 500)
  }

  return { stub, log, getFinishAttempts: () => finishAttempts }
}

async function run(name, options, expect) {
  console.log(`\n--- ${name} ---`)
  const { stub, log, getFinishAttempts } = makeStub(options)
  const original = globalThis.fetch
  globalThis.fetch = stub
  try {
    // 每次都要重新 import，因为通道是工厂函数、无模块级状态
    const { createQqChannel } = await import('../lib/channels/qq.js')
    const channel = createQqChannel({
      appId: 'stub-app',
      appSecret: 'stub-secret',
      log: { info: () => {}, warn: (m) => console.log(`    [warn] ${m}`), error: () => {} },
    })
    const result = await channel.sendFile('OPENID_STUB', FILE, 'report.txt')
    await expect({ ok: true, result, log, finishAttempts: getFinishAttempts() })
  } catch (error) {
    await expect({ ok: false, error, log, finishAttempts: getFinishAttempts() })
  } finally {
    globalThis.fetch = original
  }
}

// 1) 顺利路径
await run('正常上传（1 分片）', {}, async ({ ok, result, log }) => {
  assert(ok, '上传成功')
  assert(result?.id === 'msg_stub', 'sendFile 返回发消息响应')
  const urls = log.map((c) => c.url)
  assert(urls.some((u) => u.includes('/app/getAppAccessToken')), '先取 token')
  assert(urls.some((u) => u.includes('/upload_prepare')), '调用了 upload_prepare')
  assert(urls.some((u) => u.startsWith('https://cos.example.com/part/0')), 'PUT 了分片到预签名地址')
  assert(urls.some((u) => u.includes('/upload_part_finish')), '调用了 upload_part_finish')
  assert(urls.some((u) => u.includes('/files')), '调用了 /files 合并')
  assert(urls.some((u) => u.includes('/messages')), '最后发了富媒体消息')

  const prepare = log.find((c) => c.url.includes('/upload_prepare'))
  const bytes = Buffer.byteLength(CONTENT)
  assert(prepare.body.file_size === String(bytes), `file_size 传的是字符串字节数（${prepare.body.file_size}）`)
  assert(prepare.body.md5 && prepare.body.md5.length === 32, 'md5 是 32 位十六进制')
  assert(prepare.body.sha1 && prepare.body.sha1.length === 40, 'sha1 是 40 位十六进制')
  assert(prepare.body.md5_10m && prepare.body.md5_10m.length === 32, 'md5_10m 已提供')

  const msg = log.find((c) => c.url.includes('/messages'))
  assert(msg.body.msg_type === 7 && msg.body.media?.file_info === 'FILE_INFO_STUB', '富媒体消息体正确')
})

// 2) 线上那次失败：finish 先返回 40093001，重试后成功
await run('finish 返回 40093001 后重试（线上那次）', { failFinishTimes: 2 }, async ({ ok, log, finishAttempts }) => {
  assert(ok, '重试后上传成功')
  assert(finishAttempts === 3, `upload_part_finish 共请求 3 次（实际 ${finishAttempts}）`)
})

// 3) 一直失败：错误信息里必须带诊断
await run('finish 始终失败 → 诊断信息', { failFinishTimes: 99 }, async ({ ok, error }) => {
  assert(!ok, '按预期失败')
  const message = String(error?.message ?? '')
  assert(message.includes('40093001') || message.includes('请重试'), '错误里保留了服务端原文')
  assert(message.includes('诊断'), '错误里带上了诊断段')
  assert(message.includes('PUT 200'), '诊断里有分片 PUT 状态')
  assert(message.includes('etag='), '诊断里有 ETag（能区分"没传上去"和"服务端转存失败"）')
  assert(message.includes('bytes='), '诊断里有文件大小')
})

// 4) 分片 PUT 失败：要明确指出是 PUT 而不是 finish
await run('分片 PUT 403 → 明确报 PUT 失败', { failPut: true }, async ({ ok, error }) => {
  assert(!ok, '按预期失败')
  assert(String(error?.message ?? '').includes('PUT 失败') || String(error?.message ?? '').includes('403'), '错误指向 PUT 环节')
})

// 5) 线上那次真机失败：服务端返回的 index 从 **1** 开始。
//    用 index × block_size 当偏移会切出空缓冲区 → PUT 0 字节 → ETag 是空内容的 MD5
//    → 服务端报 40093001。这里必须证明 1 基序号也能完整传上去。
await run('分片序号从 1 开始（线上那次真机失败）', { partIndexBase: 1 }, async ({ ok, log, error }) => {
  assert(ok, `1 基 index 也能上传成功${error ? `（实际报错：${error.message.slice(0, 80)}）` : ''}`)
  const puts = log.filter((c) => c.url.startsWith('https://cos.example.com/'))
  assert(puts.length === 1, '只 PUT 了一个分片')
  assert(puts[0].bytes === Buffer.byteLength(CONTENT), `PUT 的是整个文件而不是空内容（实际 ${puts[0].bytes} 字节）`)
  assert(puts[0].bytes > 0, 'PUT 不是 0 字节（这正是线上 40093001 的根因）')
})

// 6) 多分片 + 1 基序号：累计偏移必须覆盖整个文件
await run('3 个分片 + 1 基序号', { parts: 3, blockSize: 128, partIndexBase: 1 }, async ({ ok, log, error }) => {
  assert(ok, `多分片 1 基序号也能成功${error ? `（实际报错：${error.message.slice(0, 80)}）` : ''}`)
  const puts = log.filter((c) => c.url.startsWith('https://cos.example.com/'))
  const total = puts.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0)
  assert(total === Buffer.byteLength(CONTENT), `三个分片合计等于文件大小（${total} / ${Buffer.byteLength(CONTENT)}）`)
  assert(puts.every((entry) => entry.bytes > 0), '没有空分片')
})

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${process.exitCode ? '❌ 有断言失败' : '✅ 全部通过'}`)
