/**
 * dsh-video-grab -- host plugin
 *
 * Lets an agent actually look at a video without ffmpeg installed, by driving the
 * Electron/Chromium decoder that already exists on the machine.
 *
 * WHY THIS EXISTS
 * ---------------
 * This machine has no ffmpeg and no yt-dlp. Reading a video frame by frame is
 * also unaffordable: one image costs roughly width*height/750 tokens, so a
 * 33-second 720x720 clip (883 frames) would be ~610k tokens -- an order of
 * magnitude past any context window. The way out is a CONTACT SHEET: sample the
 * clip at N points, tile the frames into one image, and read that. 20 cells of a
 * 33-second video cost about 2200 tokens and show the whole timeline at once.
 *
 * HOW DECODING WORKS
 * ------------------
 * `electron.exe` ships `ffmpeg.dll`. The plugin spawns its own tiny Electron app
 * (lib/electron/main.js), which plays the file in a hidden <video>, seeks to each
 * sample time, draws onto a canvas, and writes PNGs. The host plugin only passes
 * data and reads back a JSON receipt -- this process itself has no Electron API,
 * so it cannot decode anything on its own.
 *
 * FOUR MEASURED TRAPS (all reproduced; do not "simplify" them away)
 * -----------------------------------------------------------------
 * 1. ELECTRON_RUN_AS_NODE=1 is injected by the DSH host into its children. With
 *    it set, electron.exe starts as plain Node: no app, no window, silent exit
 *    (exit=1, ~100ms, no output). The child environment below is built
 *    explicitly so the variable simply is not there. `Remove-Item Env:` inside
 *    Windows PowerShell 5.1 was measured NOT to clear it reliably.
 * 2. A value-taking switch eats the entry script: `electron --disable-gpu
 *    sheet.js ...` becomes `--disable-gpu=sheet.js`, shifting every argument.
 *    Therefore: pass switches only as `--switch=value`, and parse the child's
 *    arguments by locating the first `.js` entry rather than by position.
 * 3. `app.exit()` can preempt a pending file write. The child waits 300ms before
 *    exiting, and every receipt is a file, never stdout.
 * 4. Never capture the child's stdio. Writing a log line into a closed pipe
 *    raises EPIPE inside the Electron main process, which surfaces as a modal
 *    "A JavaScript error occurred in the main process" popup on the user's
 *    desktop. stdio is 'ignore', and the child's own progress log lands in
 *    <outdir>/_sheet.log for diagnosis.
 *
 * ZERO DEPENDENCIES
 * -----------------
 * `@deepseek-ai/dsh-tools` is not resolvable from a profile-installed bundle on
 * this setup; its `defineTool` helper only normalises a shorthand spec into
 * plain JSON Schema. So this file builds plain JSON Schema directly and imports
 * nothing outside node: builtins.
 *
 * @module dsh-video-grab
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

export const name = 'video-grab'
export const inject = ['tools']

const HERE = dirname(fileURLToPath(import.meta.url))
const APP_DIR = join(HERE, 'electron')
// ⚠️ helper 必须是 .cjs：本包的 package.json 声明了 "type": "module"（host 侧要用 ESM），
//    这个 type 会一并套到 lib/electron/main.js 上，使它按 ESM 解析 —— 而 Electron 主进程
//    用的是 CommonJS（require('electron')），于是启动即崩：
//    "ReferenceError: require is not defined in ES module scope"（实测踩过）。
const APP_MAIN = join(APP_DIR, 'main.cjs')

/** Locate the Electron binary: explicit env var first, then the known layout. */
function findElectron() {
  const candidates = [
    process.env.DSH_ELECTRON,
    process.env.VIDEO_GRAB_ELECTRON,
    join(process.env.USERPROFILE || '', '.dsh', 'electron', 'electron.exe'),
    join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources', 'electron', 'electron.exe'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    try { if (existsSync(candidate)) return candidate } catch { /* keep looking */ }
  }
  return ''
}

const DEFAULT_TIMEOUT_MS = 180000
const MAX_CELLS = 48

function outRoot() {
  const base = join(tmpdir(), 'dsh-video-grab')
  try { mkdirSync(base, { recursive: true }) } catch { /* 已存在或不可建，后面会报错 */ }
  return base
}

/** A fresh per-call output directory so concurrent calls never collide. */
function freshOutDir(tag) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = join(outRoot(), `${tag}-${stamp}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Build the child environment explicitly: Electron/Chromium needs the user
 * profile locations, so APPDATA/LOCALAPPDATA/PATH stay, while
 * ELECTRON_RUN_AS_NODE is deliberately absent (trap 1). Deliberately NOT
 * spreading process.env, so unrelated host credentials are not inherited.
 */
function childEnv() {
  const keep = [
    'SystemRoot', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
    'APPDATA', 'LOCALAPPDATA', 'PATH', 'PATHEXT', 'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE', 'COMSPEC', 'OS', 'USERNAME', 'USERDOMAIN',
  ]
  const env = {}
  for (const key of keep) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  // 明确不带 ELECTRON_RUN_AS_NODE / ELECTRON_NO_ATTACH_CONSOLE
  return env
}

/**
 * Run the Electron helper and wait for its receipt file.
 * stdio is ignored on purpose (trap 4); progress is read from <outDir>/_sheet.log.
 */
function runElectron(args, outDir, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolvePromise) => {
    const exe = findElectron()
    if (!exe) {
      resolvePromise({ ok: false, code: 'no_electron', message: '找不到 electron.exe（可用 DSH_ELECTRON 环境变量指定）' })
      return
    }
    if (!existsSync(APP_MAIN)) {
      resolvePromise({ ok: false, code: 'no_helper', message: '插件内的 Electron helper 缺失: ' + APP_MAIN })
      return
    }
    let child
    try {
      child = spawn(exe, args, {
        cwd: APP_DIR,
        env: childEnv(),
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch (error) {
      resolvePromise({ ok: false, code: 'spawn_failed', message: String(error && error.message || error) })
      return
    }
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(value)
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 忽略 */ }
      done({
        ok: false,
        code: 'timeout',
        message: `Electron helper 超过 ${Math.round(timeoutMs / 1000)}s 未返回`,
        log: readLog(outDir),
      })
    }, timeoutMs)
    child.on('error', (error) => done({ ok: false, code: 'spawn_error', message: String(error && error.message || error) }))
    child.on('exit', (code) => {
      const receipt = join(outDir, '_result.json')
      let payload = null
      try {
        if (existsSync(receipt)) payload = JSON.parse(readFileSync(receipt, 'utf8'))
      } catch (error) {
        done({ ok: false, code: 'bad_receipt', message: '回执无法解析: ' + String(error && error.message || error), log: readLog(outDir) })
        return
      }
      if (!payload) {
        done({ ok: false, code: 'no_receipt', message: `Electron 退出码 ${code} 但没有回执`, log: readLog(outDir) })
        return
      }
      done(Object.assign({ exitCode: code }, payload))
    })
  })
}

function readLog(outDir) {
  try {
    const text = readFileSync(join(outDir, '_sheet.log'), 'utf8')
    const lines = text.trim().split('\n')
    return lines.slice(-8).join(' | ')
  } catch {
    return ''
  }
}

/* ------------------------------------------------------- speech to text --- */

/**
 * Locate a Python interpreter that has faster-whisper installed.
 *
 * Why the caller supplies the model directory instead of letting
 * faster-whisper download it: on this machine its own download path fails
 * (the hf-mirror cache/HEAD route returns nothing usable), so a model that was
 * fetched by hand -- or by any other tool -- must be usable as-is. Measured:
 * `pip install --user` into an existing ComfyUI Python works fine, and the
 * model loads in ~0.2s from a local directory.
 */
function findPython() {
  const candidates = [
    process.env.VIDEO_GRAB_PYTHON,
    process.env.VIDEO_UNDERSTAND_PYTHON,
    'D:\\AI\\ComfyUI-aki-v3.2\\python\\python.exe',
    'python',
    'python3',
  ].filter(Boolean)
  return candidates
}

/** Model directory candidates, most specific first. */
function findWhisperModel(size) {
  const name = `faster-whisper-${size}`
  const candidates = [
    process.env.VIDEO_GRAB_MODEL_DIR,
    join(process.env.USERPROFILE || '', '.dsh', 'models', name),
    `D:\\dsh\\models\\${name}`,
    join(HERE, '..', 'models', name),
  ].filter(Boolean)
  for (const dir of candidates) {
    try {
      if (dir && existsSync(join(dir, 'model.bin')) && existsSync(join(dir, 'config.json'))) {
        return { dir, name }
      }
    } catch { /* keep looking */ }
  }
  return { dir: '', name }
}

/**
 * Run the transcribe engine. Returns the parsed report written next to the txt.
 * stderr carries progress and diagnostics; stdout carries the transcript.
 */
function runTranscribe({ python, script, video, model, out, hotwords, windowSpec }) {
  return new Promise((resolvePromise) => {
    const args = [
      script,
      '--video', video,
      '--model', model,
      '--out', out,
      '--lang', 'zh',
      '--device', 'cpu',
    ]
    if (hotwords) args.push('--hotwords', hotwords)
    if (windowSpec) args.push('--window', windowSpec)
    let child
    try {
      child = spawn(python, args, {
        env: {
          ...childEnv(),
          PATH: [process.env.PATH || '', 'C:\\Users\\Elysia\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.2-full_build\\bin'].join(';'),
          PYTHONIOENCODING: 'utf-8',
          VIDEO_GRAB_FFMPEG: process.env.VIDEO_GRAB_FFMPEG || '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      resolvePromise({ ok: false, code: 'spawn_failed', message: String(error && error.message || error) })
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 忽略 */ }
    }, 900000)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolvePromise({ ok: false, code: 'spawn_error', message: String(error && error.message || error) })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      let report = null
      try {
        if (existsSync(out + '.json')) report = JSON.parse(readFileSync(out + '.json', 'utf8'))
      } catch { /* 报告读不到不算致命 */ }
      resolvePromise({ ok: code === 0 && report !== null, code, stdout, stderr: stderr.slice(-600), report })
    })
  })
}

/* ------------------------------------------------------------------ mp4 --- */

/**
 * Minimal MP4 box reader. Frames are not decoded here -- this only reports
 * container structure, which is enough to tell a caller whether a file is a
 * video, how many samples it has, and whether the codec is one Chromium can
 * decode (avc1/hvc1/mp4v/av01/vp09 yes; mjpeg/png yes and directly visible).
 */
function readBoxes(buf, start, end, acc = []) {
  let offset = start
  while (offset + 8 <= end) {
    let size = buf.readUInt32BE(offset)
    const type = buf.toString('latin1', offset + 4, offset + 8)
    let head = 8
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(offset + 8))
      head = 16
    } else if (size === 0) {
      size = end - offset
    }
    if (size < head || offset + size > end) break
    const node = { type, start: offset + head, end: offset + size }
    acc.push(node)
    if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type)) readBoxes(buf, node.start, node.end, acc)
    offset += size
  }
  return acc
}

function probeMp4(file) {
  const buf = readFileSync(file)
  const all = readBoxes(buf, 0, buf.length, [])
  const moov = all.find((b) => b.type === 'moov')
  if (!moov) return { ok: false, code: 'not_mp4', message: '没有 moov box，可能不是 MP4/还在写入' }
  const tracks = []
  for (const trak of readBoxes(buf, moov.start, moov.end, []).filter((b) => b.type === 'trak')) {
    const kids = readBoxes(buf, trak.start, trak.end, [])
    const mdia = kids.find((b) => b.type === 'mdia')
    if (!mdia) continue
    const mdiaKids = readBoxes(buf, mdia.start, mdia.end, [])
    const hdlr = mdiaKids.find((b) => b.type === 'hdlr')
    const handler = hdlr ? buf.toString('latin1', hdlr.start + 8, hdlr.start + 12) : '?'
    const minf = mdiaKids.find((b) => b.type === 'minf')
    if (!minf) continue
    const stbl = readBoxes(buf, minf.start, minf.end, []).find((b) => b.type === 'stbl')
    if (!stbl) continue
    const stblKids = readBoxes(buf, stbl.start, stbl.end, [])
    const stsd = stblKids.find((b) => b.type === 'stsd')
    const stsz = stblKids.find((b) => b.type === 'stsz')
    const mdhd = mdiaKids.find((b) => b.type === 'mdhd')
    let codec = '?'
    let width = 0
    let height = 0
    if (stsd) {
      const off = stsd.start + 8
      codec = buf.toString('latin1', off + 4, off + 8)
      if (!['mp4a', 'ac-3', 'ec-3', 'Opus'].includes(codec)) {
        // VisualSampleEntry 的宽高在 entry 起点 +32/+34：8 字节 box 头 + 6 保留 + 2 dataRefIdx
        // + 16 预定义 + 4 宽高。写 +24/+26（从 payload 算）会稳定读出 0x0 —— 实测踩过。
        width = buf.readUInt16BE(off + 8 + 24)
        height = buf.readUInt16BE(off + 8 + 26)
      }
    }
    let samples = 0
    let bytes = 0
    if (stsz) {
      const uniform = buf.readUInt32BE(stsz.start + 4)
      samples = buf.readUInt32BE(stsz.start + 8)
      bytes = uniform !== 0 ? uniform * samples : 0
      if (uniform === 0) {
        for (let i = 0; i < samples; i++) bytes += buf.readUInt32BE(stsz.start + 12 + i * 4)
      }
    }
    let durationSec = null
    if (mdhd) {
      const version = buf[mdhd.start]
      const timescale = version === 1 ? buf.readUInt32BE(mdhd.start + 20) : buf.readUInt32BE(mdhd.start + 12)
      const duration = version === 1 ? Number(buf.readBigUInt64BE(mdhd.start + 24)) : buf.readUInt32BE(mdhd.start + 16)
      if (timescale > 0) durationSec = Number((duration / timescale).toFixed(2))
    }
    tracks.push({ handler, codec, width, height, samples, bytes, durationSec })
  }
  return {
    ok: true,
    file,
    fileBytes: buf.length,
    tracks,
    video: tracks.find((t) => t.handler === 'vide' && t.samples > 0) || null,
  }
}

/* ---------------------------------------------------------------- tools --- */

const P_PATH = { type: 'string', description: '视频文件的绝对路径（mp4）' }

/** Normalise a model-supplied path that may carry quotes or forward slashes. */
function cleanPath(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim().replace(/^["']|["']$/g, '')
  return trimmed ? resolve(trimmed) : ''
}

function intOr(value, fallback, min, max) {
  const n = typeof value === 'number' ? Math.trunc(value) : Number.parseInt(value, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

function fail(summary, data) {
  return Promise.resolve({ ok: false, summary, data: data || '' })
}

/**
 * Register the video tools.
 * @param {object} ctx registrant context carrying the tool registry
 */
export function apply(ctx) {
  ctx.tools.register({
    name: 'video_probe',
    description:
      '探测视频文件的容器结构：轨道、编码、分辨率、样本数、时长。只读元数据，不解码画面，'
      + '用于判断这个文件值不值得抓帧（例如 avc1/hvc1 需要先抽帧拼图，mjpeg/png 类可直接出图）。',
    card: (args) => '探测视频 ' + (args && args.path ? String(args.path).split(/[\\/]/).pop() : ''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: P_PATH },
    },
    execute(args) {
      const file = cleanPath(args && args.path)
      if (!file) return fail('path 必须是非空字符串')
      if (!existsSync(file)) return fail('文件不存在: ' + file)
      try {
        const info = probeMp4(file)
        if (!info.ok) return Promise.resolve({ ok: false, summary: info.message, data: JSON.stringify(info) })
        const v = info.video
        const summary = v
          ? `视频 ${v.width}x${v.height} 编码 ${v.codec} 时长 ${v.durationSec ?? '?'}s 共 ${v.samples} 样本`
          : '这个文件里没有可用的视频轨'
        return Promise.resolve({ ok: true, summary, data: JSON.stringify(info) })
      } catch (error) {
        return fail('探测失败: ' + String(error && error.message || error))
      }
    },
  })

  ctx.tools.register({
    name: 'video_sheet',
    description:
      '把一条视频按时间点采样、拼成一张联系表（contact sheet），返回 PNG 的绝对路径 —— 用 read_image 读它，'
      + '一次就能看完整条片子的时间轴。这是"看视频"的推荐方式：逐帧读原图的成本约等于 宽×高÷750 token/帧，'
      + '而一张 20 格联系表约 2200 token。免 ffmpeg（借用本机 Electron 自带的解码器）。',
    card: (args) => '视频联系表 ' + (args && args.path ? String(args.path).split(/[\\/]/).pop() : ''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: P_PATH,
        cells: { type: 'integer', description: '采样格数，默认 20，范围 1-48' },
        cols: { type: 'integer', description: '每行几格，默认 5，范围 1-8' },
        cell_width: { type: 'integer', description: '每格宽度像素，默认 288，范围 96-720' },
        window: {
          type: 'string',
          description:
            '只采样某个时间段（做"片段密采"）。三种写法："30-45"（第 30 到 45 秒）、'
            + '"30"（第 30 秒到结尾）、不给则整条。用字符串而不是数字，是为了区分"从 0 秒开始"和"没指定"。',
        },
      },
    },
    async execute(args) {
      const file = cleanPath(args && args.path)
      if (!file) return fail('path 必须是非空字符串')
      if (!existsSync(file)) return fail('文件不存在: ' + file)
      const cells = intOr(args && args.cells, 20, 1, MAX_CELLS)
      const cols = intOr(args && args.cols, 5, 1, 8)
      const cellWidth = intOr(args && args.cell_width, 288, 96, 720)
      // 时间窗：字符串显式表达，缺省 = 全片（0 与"没给"必须区分开）
      let fromSeconds = 0
      let toSeconds = 0
      const windowSpec = typeof (args && args.window) === 'string' ? args.window.trim() : ''
      if (windowSpec) {
        const match = windowSpec.match(/^(\d+(?:\.\d+)?)\s*(?:-\s*(\d+(?:\.\d+)?))?$/)
        if (!match) return fail('window 格式不对，应为 "30-45" 或 "30"')
        fromSeconds = Number(match[1])
        toSeconds = match[2] === undefined ? 0 : Number(match[2])
        if (Number.isFinite(toSeconds) && toSeconds > 0 && toSeconds <= fromSeconds) {
          return fail('window 的结束时间必须大于开始时间')
        }
      }
      let outDir
      try {
        outDir = freshOutDir('sheet')
      } catch (error) {
        return fail('无法创建输出目录: ' + String(error && error.message || error))
      }
      // 只传 --switch=value 形式的开关：带值开关写成两个参数会吃掉入口脚本。
      // 入口固定是 main.cjs，第一个业务参数才是模式 —— 参数解析就永远稳定。
      const result = await runElectron([
        '--disable-gpu',
        APP_MAIN,
        'sheet',
        file,
        join(outDir, 'sheet.png'),
        String(cells),
        String(cols),
        String(cellWidth),
        String(fromSeconds),
        String(toSeconds),
      ], outDir)
      if (!result.ok) {
        return Promise.resolve({
          ok: false,
          summary: `生成联系表失败（${result.code || 'unknown'}）：${result.message || ''}`,
          data: JSON.stringify({ outDir, log: result.log || '' }),
        })
      }
      const png = join(outDir, 'sheet.png')
      if (!existsSync(png)) return fail('Electron 报了成功但没有 PNG', JSON.stringify(result))
      const size = statSync(png)
      return Promise.resolve({
        ok: true,
        summary:
          `联系表已生成：${cells} 格 / ${result.sheet || ''} / ${Math.round(size.size / 1024)} KB。`
          + `下一步用 read_image 读这个绝对路径：${png}`,
        data: JSON.stringify({
          file: png,
          bytes: size.size,
          sheet: result.sheet,
          cells: result.cells,
          durationSec: result.duration,
          video: result.video,
          times: result.times,
          outDir,
        }),
      })
    },
  })

  ctx.tools.register({
    name: 'video_frames',
    description:
      '把一条视频按固定间隔抽成多张 PNG（均匀采样），返回文件清单。'
      + '通常不需要它 —— 优先用 video_sheet（一张图看完整条，token 省得多）；'
      + '只有在需要逐帧细看某几帧、或联系表格子太小时才用它。',
    card: (args) => '抽帧 ' + (args && args.path ? String(args.path).split(/[\\/]/).pop() : ''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: P_PATH,
        frames: { type: 'integer', description: '抽多少帧，默认 12，范围 1-48' },
      },
    },
    async execute(args) {
      const file = cleanPath(args && args.path)
      if (!file) return fail('path 必须是非空字符串')
      if (!existsSync(file)) return fail('文件不存在: ' + file)
      const frames = intOr(args && args.frames, 12, 1, MAX_CELLS)
      let outDir
      try {
        outDir = freshOutDir('frames')
      } catch (error) {
        return fail('无法创建输出目录: ' + String(error && error.message || error))
      }
      const result = await runElectron([
        '--disable-gpu',
        APP_MAIN,
        'frames',
        file,
        outDir,
        String(frames),
      ], outDir)
      if (!result.ok) {
        return Promise.resolve({
          ok: false,
          summary: `抽帧失败（${result.code || 'unknown'}）：${result.message || ''}`,
          data: JSON.stringify({ outDir, log: result.log || '' }),
        })
      }
      let files = []
      try {
        files = readdirSync(outDir).filter((n) => n.endsWith('.png')).map((n) => join(outDir, n))
      } catch { /* 目录读不到就当空 */ }
      return Promise.resolve({
        ok: true,
        summary: `已抽 ${files.length} 帧到 ${outDir}（用 read_image 逐个读；帧多时优先改用 video_sheet）`,
        data: JSON.stringify({ outDir, frames: files, durationSec: result.duration, video: result.video }),
      })
    },
  })

  ctx.tools.register({
    name: 'video_fetch_bilibili',
    description:
      '取 B 站公开视频的直链并下载到本地（匿名，不需要账号或登录）。用于把在线视频变成后续 video_sheet 能读的本地文件。'
      + '只处理公开可播放的视频；付费、仅登录可见、或需要会员的内容会失败并如实报错。',
    card: (args) => '下载 B 站视频 ' + (args && args.bvid ? String(args.bvid) : ''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['bvid'],
      properties: {
        bvid: { type: 'string', description: 'BV 号，例如 BV1WLpA6uEB1（也接受完整链接）' },
        quality: { type: 'integer', description: '清晰度代码，默认 64（720P），范围 16-80' },
      },
    },
    async execute(args) {
      const raw = String((args && args.bvid) || '').trim()
      const match = raw.match(/BV[0-9A-Za-z]{8,12}/)
      if (!match) return fail('没找到 BV 号，请传 BV1xxxxxxxxx 或完整视频链接')
      const bvid = match[0]
      const quality = intOr(args && args.quality, 64, 16, 80)
      const headers = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
        Referer: 'https://www.bilibili.com/',
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Cookie: 'buvid3=A1B2C3D4-5E6F-7890-ABCD-1234567890ABCDinfoc',
      }
      const api = async (url) => {
        const response = await fetch(url, { headers })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json()
      }
      try {
        const view = await api('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid)
        if (view.code !== 0) return fail(`B 站接口拒绝了：code=${view.code} ${view.message || ''}`)
        const cid = view.data.cid
        const title = String(view.data.title || bvid)
        const play = await api(
          `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=${quality}&fnval=0&platform=html5&high_quality=1`,
        )
        if (play.code !== 0 || !play.data || !play.data.durl || !play.data.durl[0]) {
          return fail(`拿不到播放直链：code=${play.code} ${play.message || ''}`)
        }
        const direct = play.data.durl[0].url
        let outDir
        try {
          outDir = freshOutDir('bili')
        } catch (error) {
          return fail('无法创建输出目录: ' + String(error && error.message || error))
        }
        const safe = title.replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 60)
        const outFile = join(outDir, `${safe || bvid}.mp4`)
        const download = await fetch(direct, { headers })
        if (!download.ok) return fail(`下载失败：HTTP ${download.status}`)
        const buffer = Buffer.from(await download.arrayBuffer())
        writeFileSync(outFile, buffer)
        return Promise.resolve({
          ok: true,
          summary: `已下载「${title}」→ ${outFile}（${Math.round(buffer.length / 1024)} KB）。下一步用 video_sheet 看它。`,
          data: JSON.stringify({ file: outFile, bytes: buffer.length, bvid, cid, title, quality: play.data.quality }),
        })
      } catch (error) {
        return fail('下载出错: ' + String(error && error.message || error))
      }
    },
  })

  ctx.tools.register({
    name: 'video_transcribe',
    description:
      '用本地 faster-whisper 把视频里的说话转成带时间戳的文字（中文）。这是"听"的能力：'
      + '抽帧只能看画面上的字幕，转写能拿到**全部台词**，两者互相验证。'
      + '首次使用需要本地已有 whisper 模型目录（见 VIDEO_GRAB_MODEL_DIR / D:\\dsh\\models）。'
      + '内置中文热词表（assets/热词表.json）修正行业黑话误识别（token/千问/违反/飘红 等）。',
    card: (args) => '转写 ' + (args && args.path ? String(args.path).split(/[\\/]/).pop() : ''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: P_PATH,
        model_size: {
          type: 'string',
          enum: ['tiny', 'base', 'small', 'medium'],
          description: '模型档位，默认 tiny（快，72MB）；要准就用 small/medium（需先下模型）',
        },
        window: {
          type: 'string',
          description: '只转写某一段："30-45" 或 "30"（第 30 秒起）；不给则整条',
        },
      },
    },
    async execute(args) {
      const file = cleanPath(args && args.path)
      if (!file) return fail('path 必须是非空字符串')
      if (!existsSync(file)) return fail('文件不存在: ' + file)

      const size = ['tiny', 'base', 'small', 'medium'].includes(args && args.model_size)
        ? args.model_size
        : 'tiny'
      const model = findWhisperModel(size)
      if (!model.dir) {
        return fail(
          `没找到本地 whisper 模型（faster-whisper-${size}）。`
          + '把模型目录放到 D:\\dsh\\models\\ 下，或用 VIDEO_GRAB_MODEL_DIR 指定；'
          + '模型可用 huggingface_hub 的 snapshot_download 从 hf-mirror 拉（本机实测：'
          + 'snapshot_download 会失败，但按文件直接 requests.get 能下下来）。',
        )
      }
      const script = join(HERE, '..', 'tools', 'transcribe.py')
      if (!existsSync(script)) return fail('转写引擎缺失: ' + script)
      const hotwords = join(HERE, '..', 'assets', '热词表.json')

      const windowSpec = typeof (args && args.window) === 'string' ? args.window.trim() : ''
      if (windowSpec && !/^\d+(\.\d+)?(\s*-\s*\d+(\.\d+)?)?$/.test(windowSpec)) {
        return fail('window 格式不对，应为 "30-45" 或 "30"')
      }

      let outDir
      try {
        outDir = freshOutDir('transcript')
      } catch (error) {
        return fail('无法创建输出目录: ' + String(error && error.message || error))
      }
      const out = join(outDir, 'transcript.txt')

      const pythons = findPython()
      let lastError = ''
      for (const python of pythons) {
        const result = await runTranscribe({
          python, script, video: file, model: model.dir, out,
          hotwords: existsSync(hotwords) ? hotwords : '',
          windowSpec,
        })
        if (result.ok) {
          const report = result.report
          const lines = result.stdout.trim().split('\n')
          const preview = lines.slice(0, 40).join('\n')
          const more = lines.length > 40 ? `\n…（共 ${lines.length} 句，完整文本在 ${out}）` : ''
          return Promise.resolve({
            ok: true,
            summary:
              `转写完成：${report.segments.length} 句 / 热词修正 ${report.correctionsApplied} 处 / `
              + `识别耗时 ${report.timing.asr}s（模型 ${size}）。完整文本：${out}`,
            data: JSON.stringify({
              file: out,
              json: out + '.json',
              language: report.language,
              segments: report.segments.length,
              correctionsApplied: report.correctionsApplied,
              timing: report.timing,
              text: preview + more,
            }),
          })
        }
        lastError = `${python} → ${result.message || result.stderr || ('exit ' + result.code)}`
        // 解释器不对就换下一个；转写本身失败（比如模型问题）就不再试别的解释器
        if (result.code !== 2 && !/No module named|faster_whisper/i.test(lastError)) break
      }
      return Promise.resolve({
        ok: false,
        summary: '转写失败：' + lastError.slice(0, 400),
        data: JSON.stringify({ outDir, pythons }),
      })
    },
  })
}
