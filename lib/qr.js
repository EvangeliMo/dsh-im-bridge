/**
 * 本地二维码渲染。
 *
 * 微信 iLink 的 `qrcode_img_content` **不是图片地址**，而是一段
 * `https://liteapp.weixin.qq.com/q/...` 的 HTML 链接 —— 它是要被**编码进二维码**
 * 的内容。所以必须本地生成二维码图片，而不是把这个链接丢给浏览器打开。
 *
 * 用内置的 qrcode-generator（单文件、MIT、零运行时依赖），不引入 npm 依赖树。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const qrcode = require('../vendor/qrcode-generator.cjs')

/** 内容 → SVG 字符串。 */
export function qrSvg(text, { cellSize = 6, margin = 4 } = {}) {
  const qr = qrcode(0, 'M') // 0 = 自动选择版本，纠错级别 M
  qr.addData(String(text))
  qr.make()
  return qr.createSvgTag({ cellSize, margin, scalable: true })
}

/**
 * 写一个自包含的扫码页面。
 * 页面每 20 秒自动刷新一次 —— 二维码只有约 2 分钟有效期，插件会自动换新，
 * 刷新后就能看到当前有效的那个。
 */
export function writeQrPage(file, text, { title = '用手机扫码', hint = '' } = {}) {
  const svg = qrSvg(text)
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="20">
<title>${escapeHtml(title)}</title>
<style>
  html,body{height:100%;margin:0}
  body{background:#10550f;color:#eaf6e9;font:16px/1.6 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;
       display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;text-align:center}
  h1{font-size:20px;font-weight:600;margin:0}
  .card{background:#fff;padding:18px;border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,.35);line-height:0}
  .card svg{width:min(72vw,340px);height:auto}
  .hint{opacity:.85;max-width:520px;font-size:14px}
  code{background:rgba(0,0,0,.25);padding:2px 6px;border-radius:5px;font-size:12px;word-break:break-all}
</style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <div class="card">${svg}</div>
  <div class="hint">${hint}</div>
  <div class="hint">页面每 20 秒自动刷新；二维码约 2 分钟有效，过期插件会自动换新。</div>
  <code>${escapeHtml(text)}</code>
</body>
</html>`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, html, 'utf8')
  return file
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 用系统默认程序打开一个文件或 URL（仅本机桌面行为）。 */
export function openExternal(target) {
  try {
    spawn('cmd', ['/c', 'start', '', target], { windowsHide: true, detached: true, stdio: 'ignore' }).unref()
    return true
  } catch {
    return false
  }
}
