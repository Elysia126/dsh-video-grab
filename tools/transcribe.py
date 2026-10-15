#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""video-grab 的语音转写引擎（faster-whisper）。

为什么单独写一个、不用 dsh-video-understand 自带的那套：
  它依赖自己下载 whisper 模型，而在本机那一步走不通（hf-mirror 的缓存/HEAD 逻辑失败）。
  这里改成"模型目录由调用方给" —— 模型下好放哪都行，脚本只负责用它。

用法：
  python transcribe.py --video <视频> --model <模型目录> --out <输出txt>
                       [--hotwords <热词json>] [--window 10-30] [--lang zh] [--device cpu]

输出：stdout 打带时间戳的逐句文本；同时写一份 JSON 到 <输出txt>.json（含原始片段与修正记录）。
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time

# Windows 上 stdout 默认不是 UTF-8，中文会乱码
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


def die(msg, code=2):
    print(f"[transcribe] {msg}", file=sys.stderr)
    sys.exit(code)


def find_ffmpeg():
    """先看环境变量，再看 PATH，最后在常见安装位置里找。"""
    env = os.environ.get("VIDEO_GRAB_FFMPEG") or os.environ.get("VIDEO_UNDERSTAND_FFMPEG")
    if env and os.path.exists(env):
        return env
    from shutil import which
    found = which("ffmpeg")
    if found:
        return found
    # winget 装的位置带哈希目录名，扫一遍
    base = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "WinGet", "Packages")
    if os.path.isdir(base):
        for name in os.listdir(base):
            if "FFmpeg" in name:
                for root, _dirs, files in os.walk(os.path.join(base, name)):
                    if "ffmpeg.exe" in files:
                        return os.path.join(root, "ffmpeg.exe")
    return None


def extract_audio(video, wav, start=None, end=None):
    """用 ffmpeg 抽 16k 单声道 wav；给了时间窗就只抽那一段。"""
    ff = find_ffmpeg()
    if not ff:
        die("找不到 ffmpeg（设 VIDEO_GRAB_FFMPEG 或在 PATH 里放一个）")
    cmd = [ff, "-y", "-loglevel", "error"]
    if start is not None:
        cmd += ["-ss", str(start)]
    cmd += ["-i", video]
    if end is not None and start is not None:
        cmd += ["-t", str(max(0.1, end - start))]
    cmd += ["-vn", "-ac", "1", "-ar", "16000", "-f", "wav", wav]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 or not os.path.exists(wav):
        die("ffmpeg 抽音轨失败: " + (proc.stderr or "")[:300])
    return ff


def load_hotwords(path):
    """热词表：{"语音误识别": "正确写法"}。表是死的、可编辑，不靠模型猜。"""
    if not path or not os.path.exists(path):
        return {}, []
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except Exception:
        return {}, []
    table = {}
    for key, value in (raw.get("corrections") or {}).items():
        if isinstance(value, str):
            table[key] = value
    return table, list(raw.get("hints") or [])


def correct(text, table):
    """按热词表替换；返回（新文本, 命中列表）。"""
    hits = []
    out = text
    for wrong, right in table.items():
        if wrong and wrong in out:
            out = out.replace(wrong, right)
            hits.append({"from": wrong, "to": right})
    return out, hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", default="", help="视频文件路径")
    ap.add_argument("--model", default="", help="faster-whisper 模型目录（或模型名）")
    ap.add_argument("--out", default="", help="输出 txt 路径")
    ap.add_argument("--hotwords", default="", help="热词表 json 路径")
    ap.add_argument("--window", default="", help="只转写这一段，如 10-30（秒）")
    ap.add_argument("--lang", default="zh")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--model-size-hint", default="", help="仅用于报告：模型名/大小档位")
    args = ap.parse_args()

    # 缺参数时打印用法再退出，而不是抛 argparse 堆栈 —— CI 会用 `--help` 做契约检查
    if not args.video or not args.model or not args.out:
        ap.print_help()
        die("需要 --video / --model / --out 三个参数", 2)

    if not os.path.exists(args.video):
        die("视频不存在: " + args.video)
    if not os.path.isdir(args.model) and not args.model:
        die("模型目录无效: " + args.model)
    if os.path.isdir(args.model):
        for need in ("model.bin", "config.json"):
            if not os.path.exists(os.path.join(args.model, need)):
                die(f"模型目录缺少 {need}（{args.model}）—— 需完整的 faster-whisper 模型")

    start = end = None
    if args.window:
        m = re.match(r"^\s*(\d+(?:\.\d+)?)\s*(?:-\s*(\d+(?:\.\d+)?))?\s*$", args.window)
        if not m:
            die('window 格式应为 "10-30" 或 "10"')
        start = float(m.group(1))
        end = float(m.group(2)) if m.group(2) else None

    table, hints = load_hotwords(args.hotwords)

    wav = os.path.join(tempfile.gettempdir(), "vgrab-" + str(os.getpid()) + ".wav")
    t0 = time.time()
    extract_audio(args.video, wav, start, end)
    t_audio = time.time() - t0

    try:
        from faster_whisper import WhisperModel
    except Exception as error:
        die("没装 faster-whisper：" + str(error)[:200])

    t1 = time.time()
    try:
        model = WhisperModel(args.model, device=args.device, compute_type="int8")
    except Exception as error:
        die("模型加载失败：" + str(error)[:300])
    t_load = time.time() - t1

    t2 = time.time()
    try:
        segments, info = model.transcribe(
            wav,
            language=args.lang or None,
            beam_size=5,
            initial_prompt=("；".join(hints) if hints else None),  # 给模型一点领域提示
        )
        rows = []
        for seg in segments:
            raw = (seg.text or "").strip()
            fixed, hits = correct(raw, table)
            rows.append({
                "start": round(seg.start + (start or 0), 2),
                "end": round(seg.end + (start or 0), 2),
                "raw": raw,
                "text": fixed,
                "corrections": hits,
            })
    except Exception as error:
        die("转写失败：" + str(error)[:300])
    t_asr = time.time() - t2

    lines = [f"[{r['start']:7.2f}-{r['end']:7.2f}] {r['text']}" for r in rows]
    body = "\n".join(lines)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(body + "\n")
    with open(args.out + ".json", "w", encoding="utf-8") as f:
        json.dump({
            "video": args.video,
            "model": args.model,
            "modelSizeHint": args.model_size_hint,
            "window": args.window or None,
            "language": getattr(info, "language", args.lang),
            "languageProbability": round(float(getattr(info, "language_probability", 0)), 3),
            "segments": rows,
            "correctionsApplied": sum(len(r["corrections"]) for r in rows),
            "timing": {"audio": round(t_audio, 2), "modelLoad": round(t_load, 2), "asr": round(t_asr, 2)},
        }, f, ensure_ascii=False, indent=2)

    try:
        os.remove(wav)
    except OSError:
        pass

    print(body)
    print(
        f"\n[transcribe] 段数={len(rows)} 热词修正={sum(len(r['corrections']) for r in rows)} 处"
        f"  耗时: 抽音轨 {t_audio:.1f}s / 加载 {t_load:.1f}s / 识别 {t_asr:.1f}s"
        f"  语言={getattr(info, 'language', '?')}({getattr(info, 'language_probability', 0):.2f})",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
