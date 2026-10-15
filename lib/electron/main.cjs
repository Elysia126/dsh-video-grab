// main.cjs —— dsh-video-grab 的 Electron 侧：用 Chromium 自带的解码器看视频。
//
// 调用方式（由 lib/index.js 拉起）：
//   electron --disable-gpu <绝对路径>\main.cjs <sheet|frames> <video> <outPng|outDir> [n] [cols] [cellW]
//
// ⚠️ 文件名必须是 .cjs（不是 .js）：包的 package.json 里有 "type": "module"，
//    若叫 main.js 会被当成 ESM，require('electron') 直接抛
//    "ReferenceError: require is not defined in ES module scope"，Electron 启动即退（实测踩过）。
//
// ⚠️ 四条实测过的坑，别"简化"掉：
//   1. ELECTRON_RUN_AS_NODE=1（DSH 宿主注入）会让 electron 变成纯 Node —— 本文件不做处理，
//      由 lib/index.js 显式构造子进程环境来避开。
//   2. 带值开关会吃掉入口脚本（--disable-gpu sheet.js → --disable-gpu=sheet.js），
//      所以参数按"第一个 .cjs/.js 之后的"来取。
//   3. app.exit() 可能抢在文件落盘前 —— 退出前留 300ms。
//   4. 不要 console.log：往被关闭的管道写日志会 EPIPE，并在用户桌面弹出错误框。
//      回执一律写文件（_result.json），进度写 _sheet.log。
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const entryIndex = process.argv.findIndex((a) => a.endsWith('.cjs') || a.endsWith('.js'))
const argv = process.argv.slice(entryIndex + 1)

const mode = String(argv[0] || '').toLowerCase()
const videoPath = argv[1] || ''
const target = argv[2] || ''
const num1 = Number(argv[3] || 0)
const num2 = Number(argv[4] || 0)
const num3 = Number(argv[5] || 0)
const num4 = Number(argv[6] || 0)   // 时间窗起点（秒），0 = 全片
const num5 = Number(argv[7] || 0)   // 时间窗终点（秒），0 = 全片

const outDir = mode === 'sheet' ? path.dirname(path.resolve(target || '.')) : path.resolve(target || '.')
const resultFile = path.join(outDir, '_result.json')
const logFile = path.join(outDir, '_sheet.log')

function step(message) {
  try {
    fs.mkdirSync(outDir, { recursive: true })
    fs.appendFileSync(logFile, new Date().toISOString() + '  ' + message + '\n', 'utf8')
  } catch { /* 日志写不了不影响主流程 */ }
}
function writeResult(obj) {
  try {
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(resultFile, JSON.stringify(obj, null, 2), 'utf8')
    step('result written')
  } catch (error) {
    step('result WRITE FAILED: ' + error.message)
  }
}
async function finish(code) {
  step('finish code=' + code)
  await new Promise((r) => setTimeout(r, 300))
  app.exit(code)
}

process.on('uncaughtException', (error) => {
  step('uncaughtException: ' + (error && error.message ? error.message : String(error)))
  writeResult({ ok: false, error: 'uncaughtException: ' + (error && error.message ? error.message : String(error)) })
  finish(5)
})
process.on('unhandledRejection', (reason) => {
  step('unhandledRejection: ' + (reason && reason.message ? reason.message : String(reason)))
  writeResult({ ok: false, error: 'unhandledRejection: ' + (reason && reason.message ? reason.message : String(reason)) })
  finish(6)
})

step(`boot mode=${mode} video=${videoPath} target=${target} n=[${num1},${num2},${num3}] window=[${num4},${num5}] argvLen=${argv.length}`)

if (mode !== 'sheet' && mode !== 'frames') {
  writeResult({ ok: false, error: '未知模式: ' + mode })
  finish(2)
} else if (!videoPath || !fs.existsSync(videoPath)) {
  writeResult({ ok: false, error: '视频不存在: ' + videoPath })
  finish(4)
} else {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
  app.commandLine.appendSwitch('mute-audio')
  // 独立 profile：避免与其他 Electron 实例争同一个 user-data-dir 而卡住
  app.setPath('userData', path.join(os.tmpdir(), 'dsh-video-grab-profile'))

  app.whenReady().then(async () => {
    step('whenReady')
    const win = new BrowserWindow({
      width: 1280,
      height: 900,
      show: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
    })
    try {
      await win.loadFile(path.join(__dirname, 'view.html'))
      step('view.html loaded')
      const call =
        mode === 'sheet'
          ? `window.__sheet(${JSON.stringify(videoPath)}, ${JSON.stringify(path.resolve(target))}, ${num1 || 20}, ${num2 || 5}, ${num3 || 288}, ${num4 || 0}, ${num5 || 0})`
          : `window.__grab(${JSON.stringify(videoPath)}, ${JSON.stringify(path.resolve(target))}, ${num1 || 12})`
      const result = await win.webContents.executeJavaScript(call, true)
      step('page returned ok=' + (result && result.ok))
      writeResult(result)
      await finish(result && result.ok ? 0 : 2)
    } catch (error) {
      step('ERROR ' + ((error && error.message) ? error.message : String(error)))
      writeResult({ ok: false, error: (error && error.message) ? error.message : String(error) })
      await finish(3)
    }
  }, (error) => {
    step('whenReady FAILED: ' + (error && error.message ? error.message : String(error)))
    writeResult({ ok: false, error: 'whenReady failed' })
    finish(7)
  })
}
