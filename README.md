# dsh-video-grab —— 让 Agent 真的"看"视频（免 ffmpeg）

> 给 DSH 用的 host 插件。核心不是"能抓帧"，而是**用得起**：一条 33 秒的视频，
> 逐帧读完约 61 万 token（爆），拼成一张联系表约 2200 token（一次读图看完整条）。

## 一、它解决的问题

Agent 看视频有个硬约束：**读一张图的成本 ≈ 宽×高÷750 token**。

| 做法 | 33 秒 / 720×720 / 883 帧 |
|---|---|
| 逐帧读原图 | 883 × 约 690 ≈ **61 万 token**（任何上下文都装不下） |
| 一张联系表（20 格） | 1440×1152 ≈ **2200 token，一次读完** |

所以「看完一条视频」的正确姿势是**联系表**，不是抽一堆帧再一张张读。

第二个约束：这台机器上**没有 ffmpeg，也没有 yt-dlp**。解法是借本机已有的
**Electron**（`electron.exe` 自带 `ffmpeg.dll`，即 Chromium 的解码器）：
插件拉起一个隐藏窗口播 `<video>`，seek 到采样点，`drawImage` 到 canvas，导出 PNG。

## 二、四个工具

| 工具 | 作用 |
|---|---|
| `video_probe` | 只读容器结构：轨道、编码、分辨率、样本数、时长（不解码，毫秒级） |
| `video_sheet` | **主力**：按时间点采样拼一张联系表，返回 PNG 绝对路径（用 `read_image` 读） |
| `video_frames` | 均匀抽 N 帧存 PNG（只在需要逐帧细看时用，token 贵） |
| `video_fetch_bilibili` | 匿名取 B 站**公开**视频直链并下载到本地（不需要账号/登录） |

典型流程：

```
video_fetch_bilibili { bvid: "BV1WLpA6uEB1" }   → 本地 mp4 路径
video_sheet          { path: "<上一步的路径>" }  → PNG 路径
read_image           { file_path: "<PNG 路径>" } → 真的看到内容
```

## 三、实测数据（2026-10-12，本机）

| 项 | 结果 |
|---|---|
| `video_probe` 33 秒片 | 0.0s，`720x720 avc1 32.7s 883 样本`（音频轨 mp4a 1407 样本） |
| `video_sheet` 12 格 | 23.9s，成图 `1440x864`，2.1 MB |
| `video_sheet` 20 格 | 41s，成图 `1440x1152`，2.9 MB |
| `video_frames` 4 帧 | 8.8s |
| `video_fetch_bilibili` | 1.8s，下回 1571 KB |

耗时几乎全花在 seek 上：**格数越多越慢**（约 1.5-2s/格）。20 格 ≈ 40s 是常态。

## 四、⚠️ 六个实测过的坑（别"简化"掉）

1. **`ELECTRON_RUN_AS_NODE=1` 会让 electron 变成纯 Node**：它是 DSH 宿主注入给子进程的，
   一旦存在，`electron.exe` 不建窗口、不跑应用代码、静默退出（exit=1，约 100ms）。
   本插件**显式构造子进程环境**（只保留 Electron 需要的键），这个变量根本不在里面。
   注意：Windows PowerShell 5.1 里 `Remove-Item Env:` 实测**清不掉**它。
2. **`"type": "module"` 会连累 Electron helper**：本包 host 侧是 ESM，所以 package.json 有
   `"type": "module"` —— 这个 type 会一并套到 helper 上。helper 必须叫 **`main.cjs`**，
   否则 `require('electron')` 抛 `ReferenceError: require is not defined in ES module scope`，
   表现为"启动即退、没有任何输出"。
3. **带值开关会吃掉入口脚本**：`electron --disable-gpu main.cjs ...` 里，
   electron 把入口脚本当成了 `--disable-gpu` 的值（`--disable-gpu=main.cjs`），
   argv 整体位移。所以参数按**"第一个 `.cjs`/`.js` 之后的"**来取，不按位置取。
4. **`app.exit()` 可能抢在文件落盘前**：回执一律写文件（`_result.json`），退出前留 300ms。
5. **不要捕获子进程 stdio**：往被关闭的管道写日志会 EPIPE，Electron 把它升级成
   用户桌面上的模态错误框。插件的 `stdio` 固定 `'ignore'`，进度写 `<outDir>/_sheet.log`。
6. **MP4 里 VisualSampleEntry 的宽高偏移**：从 box 起点算 +32/+34（8 头 + 6 保留 + 2 dataRefIdx
   + 16 预定义 + 4 宽高）。写成 +24/+26 会**稳定读出 0x0**，且不报错 —— 实测踩过。

排查顺序建议：先看 `<outDir>/_sheet.log`（每步都有时间戳），再看 `_result.json`，
最后才怀疑环境。**"没有日志"本身就是结论**：说明进程没进到应用代码。

## 五、依赖与边界

- **零 npm 依赖**（只用 node: 内置模块 + 本机 `electron.exe`）。
- Electron 位置：`DSH_ELECTRON` / `VIDEO_GRAB_ELECTRON` 环境变量优先，
  否则找 `%USERPROFILE%\.dsh\electron\electron.exe`。
- **只支持 Chromium 能解的编码**（H.264/H.265/VP9/AV1…）。本机是精简版 Electron，
  **专有编码可能缺失**；遇到解不了的情况会如实报"没有可解码的画面"，不会假装成功。
- **音频听不到**：只处理画面。台词要靠视频自带的字幕/画面文字，或另行转写。
- **只能看定格**：联系表是N 张静态图，运动过程、节奏、音效都拿不到。
- B 站下载**只处理公开视频**，付费/仅登录可见会如实失败；文件名里的非法字符会被替换。

## 六、安装 / 卸载

```powershell
$dsh = "C:\Users\Elysia\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh plugin --profile desktop add    D:\workspace\workplace2\dsh-video-grab-0.1.0.tgz
& $dsh plugin --profile desktop remove dsh-video-grab
```

装完要**重启 / 开新会话**才会出现这四个工具（host 侧的 JS 是加载时进内存的）；
helper 的改动则立即生效（每次调用现读磁盘）。

## 七、许可与出处

- MIT。解码借用本机已安装的 Electron，不随包分发任何运行时。
- B 站接口按公开页面所见的调用方式使用，仅取公开视频、匿名访问；请自行遵守平台条款。
