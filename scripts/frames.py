# -*- coding: utf-8 -*-
"""Contact sheet of videos: one row per video, frames evenly spaced in time, so seed
variants can be compared at a glance. The first column is the first frame.

    python frames.py a.mp4 b.mp4 ... [--frames 6] [--width 256] --out sheet.png

Reads frames with OpenCV (cv2) when installed, else with ffmpeg (on PATH or from
imageio-ffmpeg). Needs Pillow.
"""

from __future__ import annotations

import argparse
import io
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass


def _ffmpeg() -> str | None:
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def frames_cv2(path: Path, count: int) -> tuple[list[Image.Image], float]:
    import cv2

    cap = cv2.VideoCapture(str(path))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    if total <= 0:
        raise RuntimeError("读不出帧数")
    out = []
    for i in range(count):
        index = round(i * (total - 1) / max(1, count - 1))
        cap.set(cv2.CAP_PROP_POS_FRAMES, index)
        ok, frame = cap.read()
        if ok:
            out.append(Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)))
    cap.release()
    return out, total / fps


def frames_ffmpeg(path: Path, count: int) -> tuple[list[Image.Image], float]:
    exe = _ffmpeg()
    if not exe:
        raise RuntimeError("没有 OpenCV，也找不到 ffmpeg（pip install opencv-python 或 imageio-ffmpeg）")
    probe = subprocess.run([exe, "-i", str(path)], capture_output=True, text=True, encoding="utf-8", errors="replace")
    seconds = 0.0
    for line in probe.stderr.splitlines():
        if "Duration:" in line:
            h, m, s = line.split("Duration:")[1].split(",")[0].strip().split(":")
            seconds = int(h) * 3600 + int(m) * 60 + float(s)
    out = []
    for i in range(count):
        t = min(seconds - 0.05, i * seconds / max(1, count - 1)) if seconds else 0
        png = subprocess.run([exe, "-v", "error", "-ss", f"{max(0, t):.3f}", "-i", str(path), "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"], capture_output=True)
        if png.stdout:
            out.append(Image.open(io.BytesIO(png.stdout)).convert("RGB"))
    return out, seconds


def read_frames(path: Path, count: int) -> tuple[list[Image.Image], float]:
    try:
        import cv2  # noqa: F401
    except ImportError:
        return frames_ffmpeg(path, count)
    return frames_cv2(path, count)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("videos", nargs="+")
    parser.add_argument("--frames", type=int, default=6)
    parser.add_argument("--width", type=int, default=256, help="每帧宽度（像素）")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    font = ImageFont.load_default()
    rows = []
    for video in args.videos:
        path = Path(video)
        try:
            frames, seconds = read_frames(path, max(2, args.frames))
        except Exception as error:  # one broken video must not hide the others
            print(f"{path.name}: {error}", file=sys.stderr)
            continue
        if not frames:
            print(f"{path.name}: 没有读到帧", file=sys.stderr)
            continue
        w = args.width
        h = round(frames[0].height * w / frames[0].width)
        row = Image.new("RGB", (w * len(frames), h + 16), "white")
        draw = ImageDraw.Draw(row)
        for i, frame in enumerate(frames):
            row.paste(frame.resize((w, h)), (i * w, 16))
            t = i * seconds / max(1, len(frames) - 1)
            draw.text((i * w + 3, 2), f"{t:.1f}s", fill="black", font=font)
        draw.text((w * len(frames) - 6 * len(path.name) - 4, 2), path.name, fill="gray", font=font)
        rows.append(row)
    if not rows:
        return 1
    sheet = Image.new("RGB", (max(r.width for r in rows), sum(r.height + 4 for r in rows)), "white")
    y = 0
    for row in rows:
        sheet.paste(row, (0, y))
        y += row.height + 4
    sheet.save(args.out)
    print(f"{args.out}  {len(rows)} 条 × {args.frames} 帧")
    return 0


if __name__ == "__main__":
    sys.exit(main())
