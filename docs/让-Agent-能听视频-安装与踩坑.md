# 让 Agent 能"听"视频 —— 安装与踩坑记录

> 2026-10-12/13 实测。目标：让 agent 拿到视频里的**台词**（不只是画面），也就是补上"耳朵"。
> 环境：Windows 10、DSH 桌面端（desktop profile）、无独显可用（RTX 5060 4GB）、Clash 代理在跑。

## 一、两条路线，最后都留着

| 路线 | 是什么 | 什么时候用 |
|---|---|---|
| **A. 别人做好的插件** `dsh-video-understand` | AVIS 信息层（本地 ASR + 场景 + 运动轨迹 + YOLO）→ 约 1k token 的摘要/问答；L0 全本地 | 想快速知道"这条视频讲了什么"、要省 token |
| **B. 我们自己插件里的** `video_transcribe` | 本地 faster-whisper 转写，**模型目录自己指定**，带中文热词表修正 | 要**逐句台词**、要可靠（不依赖插件自己下模型） |

**为什么两条都要**：A 的自动下载模型在本机**走不通**（见第三节），而 B 正好绕开了那一步。

## 二、A 路线：装 dsh-video-understand

```powershell
# 1) ffmpeg（前置条件，必需）
winget install -e --id Gyan.FFmpeg --accept-package-agreements --accept-source-agreements
#    ⚠ 装完只是改了系统 PATH，当前进程里 still 看不见 —— 要手动把 bin 目录并进 PATH

# 2) 插件
& "<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add dsh-video-understand

# 3) Python 侧依赖（核心层约 200-300MB）
#    借本机已有的 Python（这里是 ComfyUI 自带的 3.13），--user 装，不污染 ComfyUI
D:\AI\ComfyUI-aki-v3.2\python\python.exe -m pip install --user `
  -i https://pypi.tuna.tsinghua.edu.cn/simple `
  'faster-whisper>=1.0,<2.0' 'opencv-python-headless>=4.8' 'yt-dlp>=2024.8' 'xxhash>=3.4'

# 4) 告诉插件用哪个 Python / ffmpeg
[Environment]::SetEnvironmentVariable('VIDEO_UNDERSTAND_PYTHON', 'D:\AI\ComfyUI-aki-v3.2\python\python.exe', 'User')
[Environment]::SetEnvironmentVariable('VIDEO_UNDERSTAND_FFMPEG', '<...>\ffmpeg.exe', 'User')

# 5) LLM key（它默认指向 MiMo，我们改用 DeepSeek）
#    key 就在 ~/.dsh/.credentials.yaml 里（DEEPSEEK_API_KEY）
[Environment]::SetEnvironmentVariable('LLM_API_KEY', '<sk-...>', 'User')
[Environment]::SetEnvironmentVariable('LLM_API_URL', 'https://api.deepseek.com/v1/chat/completions', 'User')
[Environment]::SetEnvironmentVariable('LLM_MODEL', 'deepseek-flash', 'User')

# 6) 自检
node "<插件目录>\bin\doctor.mjs"      # 期望：🎉 环境就绪
```

## 三、⚠️ 三个实测踩到的坑

1. **`doctor` 看不见低层工具**：`winget` 装完 ffmpeg、ComfyUI 的 Python 没进系统 PATH，doctor 会报"未找到 Python / ffmpeg 未安装"。**不是没装，是它找不到** —— 用 `VIDEO_UNDERSTAND_*` 环境变量直指即可。
2. **`Start-Job` 的后台作业会随进程消失**：把它交给 `Start-Job` 后，下一个工具调用就查不到那个作业了（`job_list` 空、进程没了、输出为空）。**长任务要么前台等，要么用能活下来的方式跑。**
3. **faster-whisper 自己下模型会失败**（`LocalEntryNotFoundError`），但**同样的网络直连下载是通的**：
   - `huggingface_hub.snapshot_download(...)` → 失败
   - `requests.get("https://hf-mirror.com/<repo>/resolve/main/<file>", allow_redirects=True)` → **成功**（它会跳到 huggingface.co 的 resolve-cache）
   ⇒ 结论：**别依赖它的自动下载，自己按文件下**。faster-whisper 模型需要这几个文件：
     `config.json`、`model.bin`、`tokenizer.json`、`vocabulary.txt`

## 四、B 路线：自己下模型 + 用 `video_transcribe`

```powershell
# 下模型（以 tiny 为例，约 75MB；small 约 500MB、medium 约 1.5GB）
# 用一个 python 脚本按文件下到 D:\dsh\models\faster-whisper-tiny\
#   repo: Systran/faster-whisper-tiny（或 -small / -medium）
```

模型放好后，插件工具就能直接用（`findWhisperModel()` 会依次找
`VIDEO_GRAB_MODEL_DIR` → `%USERPROFILE%\.dsh\models\<name>` → `D:\dsh\models\<name>`）。

**热词表**（`assets/热词表.json`）是这套的杀手锏 —— whisper 不认识我们这行的黑话，实测：

| 模型听成 | 实际是 | 属于 |
|---|---|---|
| 千万 | **千问** | 模型名 |
| 偷肯 | **token** | 术语 |
| 维反 | **违反** | 常用词 |
| 票红 | **飘红** | 行话 |
| 风际 | **风纪** | 常用词 |
| 牛二 | **牛啊** | 语气词 |

改这个 JSON 就行，不用动代码。除了 `corrections`（硬替换），还有 `hints`（给模型的领域提示词）。

## 五、分工（别重复造轮子，也别浪费已有的）

```
video_fetch_bilibili  → 拿视频（匿名，不依赖 yt-dlp）
video_probe           → 容器结构：多久、多大、多少帧
video_transcribe      → 【听】逐句台词 + 时间戳（热词表修正）
video_sheet           → 【看】整条或某一段的联系表（window 密采）
video_frames          → 【看】逐帧（少用，token 贵）
img-grab（另一工具）   → 多张大图拼一张表，省 token
dsh-video-understand  → 【听+理解】信息层摘要与问答（省 token，但模型要自己下）
```

**判断口诀**：问"讲了什么"用 `dsh-video-understand`；问"这句话到底怎么说的"用 `video_transcribe`；
问"画面里那个人穿什么颜色"用 `video_sheet`。
