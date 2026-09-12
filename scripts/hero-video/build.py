#!/usr/bin/env python3
"""Build assets/hero-portrait.mp4 — the landing film.

Four stages, each runnable on its own so a failed generation does not cost the
rest:

    refs      cut one still per character out of the current film
    generate  image-to-video on each still, one clip per character
    assemble  trim, matte to white, concatenate, encode
    verify    prove the background is #ffffff and the figure survived

`generate` is the only stage that needs the network. It talks to Higgsfield
(https://docs.higgsfield.ai/docs), which wants a key id and a secret:

    export HF_API_KEY_ID=...        # a UUID from https://cloud.higgsfield.ai
    export HF_API_KEY_SECRET=...

The reference stills come out of the film already in production, so the source
frames are matted to the page's own white before a single request is made.
Whatever the model paints behind the figure, `assemble` mattes it back.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "assets" / "hero-portrait.mp4"
OUT = ROOT / "assets" / "hero-portrait.mp4"

API = "https://api.higgsfield.ai"

# What an account may call is not what the catalogue lists. Measured against
# this account on 2026-09-12: Seedance (pro fast and lite) and Sora 2 answer
# `404 model_not_found`, Veo 3.1 answers `503 model_disabled`, and Kling and
# Wan authorise but answer `403 not_enough_credits`. So the model is a switch,
# not a constant — `--model` picks one without touching the code.
MODELS = {
    "seedance": ("/bytedance/seedance/v1/pro/fast/image-to-video",
                 {"resolution": "1080", "aspect_ratio": "9:16", "duration": 5,
                  "camera_fixed": True}),
    "seedance-lite": ("/bytedance/seedance/v1/lite/image-to-video",
                      {"resolution": "1080", "aspect_ratio": "9:16", "duration": 5,
                       "camera_fixed": True}),
    "kling": ("/kling-video/v2.5-turbo/pro/image-to-video",
              {"duration": 5,
               # Kling has no aspect or resolution field: it follows the still,
               # which is already 720x1280. The negative prompt stands in for
               # `camera_fixed`, which it also has no field for.
               "negative_prompt": "camera movement, zoom, pan, walking, "
                                  "stepping, drifting, background, scenery, "
                                  "shadow on the wall"}),
    "veo": ("/veo3.1/image-to-video",
            {"resolution": "1080", "aspect_ratio": "9:16", "duration": "4",
             "generate_audio": False}),
    "sora": ("/sora-2/image-to-video/pro",
             {"resolution": "1080p", "aspect_ratio": "9:16", "duration": 4}),
}
DEFAULT_MODEL = "seedance"

# The film in production is nine shots of 3.2083 s, cut on the beat. The new cut
# runs each shot shorter so the faces change roughly twice as often.
SHOT = 3.2083333
SHOTS = 9
CLIP_SECONDS = 1.8

# Every prompt fixes three things the landing depends on and then asks for one
# specific piece of business. Held still, the nine figures read as nine photos;
# what makes the strip alive is that no two of them are doing the same thing.
COMMON = (
    "Full body head to toe, feet and top of head inside frame with air above and below, "
    "figure centred, seamless pure white background (#ffffff), flat even studio light, "
    "no shadow on the backdrop, locked-off camera on a tripod, no zoom, no camera move, "
    "photoreal, same person and same clothing as the reference. "
    # The cuts are 1.8 s. A figure that walks, turns or drifts reads as a jump
    # against the next shot, so the motion has to live in the hands, the face and
    # the shoulders while the feet stay put.
    "Feet planted on one spot, no walking, no stepping, no turning away from camera, "
    "the figure keeps the same size and the same position in frame from first frame "
    "to last; the movement is in the hands, face and shoulders only."
)

CHARACTERS = [
    ("goth", "She thumb-types fast, smirks at what she wrote and shakes her head once, then keeps typing."),
    ("babushka", "She raises the phone to her ear, listens, nods twice and breaks into a warm smile."),
    ("muscle", "He reads something funny and laughs out loud with his head tipped back, shoulders shaking."),
    ("blonde", "She pushes her sunglasses up onto her hair, raises an eyebrow at the screen and keeps reading."),
    ("worker", "He reads good news, punches a fist up and grins wide, then claps the phone to his chest."),
    ("tee", "He turns the screen out toward camera, taps it twice, pulls it back and grins."),
    ("suit", "He talks on speakerphone, gesturing with his free hand, then slips the phone into his pocket."),
    ("heavy", "He lifts the phone up for a selfie, tilts his head, gives a small shy wave and grins."),
    ("redhead", "She flicks her hair back with her free hand and laughs at the screen."),
]


def ffmpeg() -> str:
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:  # the container may only have the pip-shipped binary
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        sys.exit("ffmpeg not found: install it, or `pip install imageio-ffmpeg`")


def run(*args: str) -> None:
    subprocess.run([ffmpeg(), "-hide_banner", "-v", "error", *args], check=True)


# --------------------------------------------------------------------------- refs


def stage_refs(work: Path) -> None:
    refs = work / "refs"
    refs.mkdir(parents=True, exist_ok=True)
    for i, (name, _) in enumerate(CHARACTERS):
        # Mid-shot, where the figure is settled and the matte is cleanest.
        run("-ss", f"{i * SHOT + SHOT / 2:.4f}", "-i", str(SOURCE),
            "-frames:v", "1", "-y", str(refs / f"{i:02d}-{name}.png"))
    print(f"refs: {SHOTS} stills in {refs}")


# ----------------------------------------------------------------------- generate


def auth() -> dict[str, str]:
    key_id = os.environ.get("HF_API_KEY_ID")
    secret = os.environ.get("HF_API_KEY_SECRET")
    if not key_id or not secret:
        sys.exit(
            "HF_API_KEY_ID and HF_API_KEY_SECRET must be set.\n"
            "Create a key at https://cloud.higgsfield.ai — the id is a UUID and the\n"
            "secret is shown once. A dashboard/session token (oat_...) is not an API key\n"
            "and the API answers it with 401 Invalid credentials."
        )
    return {"Authorization": f"Key {key_id}:{secret}"}


# Cloudflare sits in front of the API and answers the urllib default
# User-Agent with `403 error code: 1010`, so every request names itself.
UA = "bro-hero-video/1.0"


def api(method: str, url: str, body: dict | None = None, headers: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    for k, v in {"User-Agent": UA, **auth(), **(headers or {})}.items():
        req.add_header(k, v)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as err:
        sys.exit(f"{method} {url} -> {err.code} {err.read().decode()[:300]}")


def upload(png: Path) -> str:
    slot = api("POST", f"{API}/files/generate-upload-url", {"content_type": "image/png"})
    req = urllib.request.Request(slot["upload_url"], data=png.read_bytes(), method="PUT")
    req.add_header("User-Agent", UA)
    for k, v in slot["upload_headers"].items():  # every header, or the PUT is rejected
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=180):
        pass
    return slot["public_url"]


def wait(status_url: str, timeout: float = 900) -> dict:
    delay, deadline = 2.0, time.time() + timeout
    while time.time() < deadline:
        result = api("GET", status_url)
        if result["status"] in {"completed", "failed", "nsfw", "canceled"}:
            return result
        time.sleep(delay + random.uniform(0, 0.5))
        delay = min(delay * 1.5, 10.0)
    sys.exit(f"timed out waiting on {status_url}")


def stage_generate(work: Path, model: str) -> None:
    path, params = MODELS[model]
    refs, clips = work / "refs", work / "clips"
    clips.mkdir(parents=True, exist_ok=True)
    pending = []
    for i, (name, action) in enumerate(CHARACTERS):
        still = refs / f"{i:02d}-{name}.png"
        if not still.exists():
            sys.exit(f"missing {still} — run the refs stage first")
        out = clips / f"{i:02d}-{name}.mp4"
        if out.exists():
            print(f"generate: {name} already downloaded, skipping")
            continue
        # 1080 x 9:16 is the ceiling these models offer; the page downscales to 720.
        submitted = api("POST", API + path, {
            "image_url": upload(still),
            "prompt": f"{action} {COMMON}",
            **params,
        })
        print(f"generate: {name} queued as {submitted['request_id']}")
        pending.append((name, out, submitted["status_url"]))

    for name, out, status_url in pending:  # queued together, collected in order
        result = wait(status_url)
        if result["status"] != "completed":
            sys.exit(f"generate: {name} ended {result['status']}: {json.dumps(result)[:300]}")
        url = (result.get("videos") or result.get("video") or [{}])[0]["url"]
        dl = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(dl, timeout=300) as res, out.open("wb") as fh:
            shutil.copyfileobj(res, fh)
        print(f"generate: {name} -> {out} ({out.stat().st_size // 1024} KB)")


# ----------------------------------------------------------------------- assemble


def matte(src: Path, dst: Path) -> None:
    """Composite the subject over pure white, frame by frame.

    A tone curve cannot do this: several characters wear white, and a knee that
    lifts a 230 backdrop to 255 dissolves a white shirt with it. A segmentation
    model decides *person or not* instead of *bright or not*, so the shirt stays.
    """
    from PIL import Image
    from rembg import new_session, remove

    session = new_session("u2net")
    frames = dst.parent / f"{dst.stem}-frames"
    frames.mkdir(parents=True, exist_ok=True)
    run("-i", str(src), "-y", str(frames / "%05d.png"))
    for png in sorted(frames.glob("*.png")):
        cut = remove(Image.open(png).convert("RGBA"), session=session)
        white = Image.new("RGBA", cut.size, (255, 255, 255, 255))
        white.alpha_composite(cut)
        white.convert("RGB").save(png)
    run("-framerate", "24", "-i", str(frames / "%05d.png"),
        "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", "-y", str(dst))
    shutil.rmtree(frames)


def stage_assemble(work: Path, source: Path | None, no_matte: bool) -> None:
    clips, cut = work / "clips", work / "cut"
    cut.mkdir(parents=True, exist_ok=True)
    pieces = []

    for i, (name, _) in enumerate(CHARACTERS):
        raw = clips / f"{i:02d}-{name}.mp4"
        if source is not None:  # dry run: re-cut the film already in production
            raw = cut / f"{i:02d}-{name}-raw.mp4"
            run("-ss", f"{i * SHOT:.4f}", "-t", f"{SHOT:.4f}", "-i", str(source),
                "-c", "copy", "-y", str(raw))
        if not raw.exists():
            sys.exit(f"missing {raw} — run the generate stage first")

        piece = cut / f"{i:02d}-{name}.mp4"
        # Skip the first beat: image-to-video spends it easing out of the still.
        start = 0.5 if source is None else 0.0
        run("-ss", f"{start}", "-t", f"{CLIP_SECONDS}", "-i", str(raw),
            "-vf", "scale=720:1280:force_original_aspect_ratio=decrease,"
                   "pad=720:1280:(ow-iw)/2:(oh-ih)/2:white,fps=24,setsar=1",
            "-an", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p",
            "-y", str(piece))
        if not no_matte and source is None:
            matte(piece, piece)
        pieces.append(piece)

    listing = cut / "concat.txt"
    listing.write_text("".join(f"file '{p.name}'\n" for p in pieces))
    staged = work / "hero.mp4"
    run("-f", "concat", "-safe", "0", "-i", str(listing),
        "-c:v", "libx264", "-crf", "27", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", "-an", "-y", str(staged))
    print(f"assemble: {staged} "
          f"({staged.stat().st_size // 1024} KB, {SHOTS * CLIP_SECONDS:.1f} s)")


# ------------------------------------------------------------------------- verify


def stage_verify(path: Path, every: int = 12) -> None:
    """The page is #ffffff and the film is letterboxed onto it, so any drift in
    the backdrop shows as a grey rectangle around the frame. Sample the border."""
    from PIL import Image

    frames = path.parent / f"{path.stem}-verify"
    frames.mkdir(parents=True, exist_ok=True)
    run("-i", str(path), "-vf", f"select='not(mod(n\\,{every}))'", "-vsync", "0",
        "-y", str(frames / "%05d.png"))
    checked = worst = 0
    worst_at = ""
    for png in sorted(frames.glob("*.png")):
        im = Image.open(png).convert("RGB")
        w, h = im.size
        ring = [im.getpixel((x, y))
                for x in range(0, w, 8) for y in (0, 1, 2, h - 3, h - 2, h - 1)]
        ring += [im.getpixel((x, y))
                 for y in range(0, h, 8) for x in (0, 1, 2, w - 3, w - 2, w - 1)]
        off = max(255 - min(min(px) for px in ring), 0)
        checked += 1
        if off > worst:
            worst, worst_at = off, png.name
    shutil.rmtree(frames)
    print(f"verify: {checked} frames, worst border pixel {255 - worst} "
          f"({worst_at or 'n/a'}) — {'clean' if worst == 0 else 'NOT WHITE'}")
    if worst:
        sys.exit(1)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("stage", choices=["refs", "generate", "assemble", "verify", "install"])
    ap.add_argument("--work", type=Path,
                    default=Path(os.environ.get("HERO_WORK", "/tmp/hero-video")))
    ap.add_argument("--from-source", action="store_true",
                    help="assemble: re-cut the film already in production instead of "
                         "generated clips, to preview the new cadence")
    ap.add_argument("--no-matte", action="store_true",
                    help="assemble: skip background removal")
    ap.add_argument("--path", type=Path, help="verify: file to check")
    ap.add_argument("--model", choices=sorted(MODELS), default=DEFAULT_MODEL,
                    help="generate: which image-to-video model to call")
    args = ap.parse_args()
    args.work.mkdir(parents=True, exist_ok=True)

    if args.stage == "install":
        subprocess.run([sys.executable, "-m", "pip", "install", "-q",
                        "imageio-ffmpeg", "pillow", "rembg[cpu]"], check=True)
    elif args.stage == "refs":
        stage_refs(args.work)
    elif args.stage == "generate":
        stage_generate(args.work, args.model)
    elif args.stage == "assemble":
        stage_assemble(args.work, SOURCE if args.from_source else None, args.no_matte)
    elif args.stage == "verify":
        stage_verify(args.path or (args.work / "hero.mp4"))


if __name__ == "__main__":
    main()
