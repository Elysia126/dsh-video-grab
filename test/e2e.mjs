// e2e.mjs —— 端到端验收 dsh-video-grab 插件。
// 做法：用假的 ctx 收集插件注册的工具，然后像 Agent 那样逐个调用它们。
//   node test/e2e.mjs probe  <视频>
//   node test/e2e.mjs sheet  <视频> [格数]
//   node test/e2e.mjs frames <视频> [帧数]
//   node test/e2e.mjs fetch  <BV号>
import { pathToFileURL } from 'node:url'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// 本文件在 <插件根>/test/ 下，所以插件根就是上一级 —— 挪动本文件要同步改这里
const pluginRoot = resolve(here, '..')
const mod = await import(pathToFileURL(join(pluginRoot, 'lib', 'index.js')).href)

const tools = new Map()
const ctx = { tools: { register: (definition) => { tools.set(definition.name, definition); return () => {} } } }
mod.apply(ctx)

console.log('插件导出 name =', mod.name, ' inject =', JSON.stringify(mod.inject))
console.log('注册到的工具:', [...tools.keys()].join(', '))

const [mode, target, extra, extra2, extra3, extra4] = process.argv.slice(2)
if (!mode) {
  console.log('用法: node test/e2e.mjs <probe|sheet|frames|fetch|transcribe> <参数...>')
  console.log('  probe      <视频>')
  console.log('  sheet      <视频> [cells=20] [cols=5] [w=288] [window=30-45]')
  console.log('  frames     <视频> [帧数]')
  console.log('  fetch      <BV号>')
  console.log('  transcribe <视频> [模型档位 tiny|base|small|medium] [window]')
  process.exit(0)
}

const call = async (name, args) => {
  const definition = tools.get(name)
  if (!definition) { console.log(`✗ 没有工具 ${name}`); return null }
  const started = Date.now()
  const result = await definition.execute(args)
  const ms = Date.now() - started
  console.log(`\n=== ${name}(${JSON.stringify(args)}) ===`)
  console.log(`耗时 ${(ms / 1000).toFixed(1)}s  ok=${result.ok}`)
  console.log('summary: ' + result.summary)
  if (result.data) console.log('data: ' + String(result.data).slice(0, 900))
  return result
}

if (mode === 'probe') await call('video_probe', { path: target })
if (mode === 'sheet') {
  // 一律用命名参数，别用位置索引 —— 位置索引已经害我写错过一次 to_seconds
  //   node test/e2e.mjs sheet <视频> cells=10 cols=5 w=384 from=30 to=45
  const args = { path: target }
  for (const token of process.argv.slice(3)) {
    const eq = String(token).indexOf('=')
    if (eq === -1) continue
    const key = String(token).slice(0, eq)
    const value = String(token).slice(eq + 1)
    const n = Number(value)
    if (key === 'cells') args.cells = n
    else if (key === 'cols') args.cols = n
    else if (key === 'w' || key === 'cell_width') args.cell_width = n
    else if (key === 'window') args.window = value
  }
  if (args.cells === undefined) args.cells = 20
  await call('video_sheet', args)
}
if (mode === 'frames') await call('video_frames', { path: target, frames: Number(extra || 8) })
if (mode === 'fetch') await call('video_fetch_bilibili', { bvid: target })
if (mode === 'transcribe') {
  // node test/e2e.mjs transcribe <视频> [model_size] [window]
  const args = { path: target }
  if (extra) args.model_size = extra
  if (extra2) args.window = extra2
  await call('video_transcribe', args)
}
