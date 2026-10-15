"""Fixture for f-voice-meeting-protocol: golosovoe.ogg — a Telegram-style voice message (OGG/Opus, mono,
48 kHz, 24 kbit/s) with the results of a parents' meeting, read in Russian by a synthetic voice.

Speech comes from the ElevenLabs text-to-speech API (model eleven_multilingual_v2, premade voice «Matilda»,
fixed voice settings and seed). The API is not bit-exact between calls, so the MP3 it returns is cached in
scripts/bench/files/cache/ and every later build reuses it: with the cache present the build is offline and the OGG
is byte-identical (ffmpeg with +bitexact). Without the cache the build needs ELEVENLABS_API_KEY.

Post-processing (ffmpeg): 0.35 s of silence before and 0.6 s after the speech, a 90 Hz high-pass and
7.8 kHz low-pass like a phone microphone, then libopus VOIP 24k mono 48 kHz, metadata stripped except a
title tag «ОБРАЗЕЦ / SPECIMEN …» (an audio file cannot carry a visible mark; all names are fictional).

truth/golosovoe.json — the spoken text, the facts a protocol must contain, the expected collection numbers
(25 pupils × (1 500 + 900) = 60 000, 2 400 per pupil), audio parameters and the voice used.
"""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import ssl
import subprocess
import sys
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import common as C  # noqa: E402

CASE = "f-voice-meeting-protocol"
FIXTURE = "golosovoe.ogg"
CACHE_DIR = HERE.parent / "cache"

TEXT = (
    "Протокол родительского собрания пятого Б класса от четырнадцатого октября две тысячи двадцать шестого года. "
    "Присутствовали восемнадцать родителей из двадцати пяти. "
    "Председатель Смирнова Анна Викторовна, секретарь Ким Елена Владимировна. "
    "Первый вопрос: сбор на подарки учителям к Новому году по тысяче пятьсот рублей с ученика. "
    "Голосовали: за — шестнадцать, против — один, воздержался — один. Решение принято. "
    "Второй вопрос: экскурсия в планетарий двадцатого ноября, стоимость девятьсот рублей с ученика, "
    "оплата до десятого ноября. За — восемнадцать, единогласно. "
    "Ответственная за сбор денег — Смирнова Анна Викторовна. "
    "Третий вопрос: дежурство родителей на ёлке — составить график до первого декабря, "
    "ответственная Ким Елена Владимировна."
)

VOICE = dict(voice_id="XrExE9yKIg1WjnnlVkGX", name="Matilda", category="premade")
MODEL = "eleven_multilingual_v2"
OUTPUT_FORMAT = "mp3_44100_64"
SEED = 1410
VOICE_SETTINGS = dict(stability=0.5, similarity_boost=0.75, style=0.0, use_speaker_boost=True, speed=1.0)

FACTS = dict(
    date="2026-10-14", klass="5 «Б»", present=18, total_parents=25,
    chair="Смирнова Анна Викторовна", secretary="Ким Елена Владимировна",
    questions=[
        dict(n=1, topic="Сбор на подарки учителям к Новому году", amount_per_pupil=1500,
             votes=dict(za=16, protiv=1, vozderzhalis=1), decision="принято"),
        dict(n=2, topic="Экскурсия в планетарий 20.11.2026", amount_per_pupil=900, pay_until="2026-11-10",
             votes=dict(za=18, protiv=0, vozderzhalis=0), decision="принято единогласно",
             responsible="Смирнова Анна Викторовна (сбор денег)"),
        dict(n=3, topic="Дежурство родителей на ёлке — график до 01.12.2026",
             responsible="Ким Елена Владимировна"),
    ],
)
EXPECTED = dict(pupils=25, per_pupil=1500 + 900, total=25 * (1500 + 900), gifts_total=25 * 1500,
                planetarium_total=25 * 900)


def _request_body() -> bytes:
    return json.dumps(dict(text=TEXT, model_id=MODEL, voice_settings=VOICE_SETTINGS, seed=SEED),
                      ensure_ascii=False, sort_keys=True).encode("utf-8")


def _cache_path() -> pathlib.Path:
    key = hashlib.sha256(_request_body() + VOICE["voice_id"].encode() + OUTPUT_FORMAT.encode()).hexdigest()[:12]
    return CACHE_DIR / f"golosovoe_{VOICE['name'].lower()}_{key}.mp3"


def _ssl_context():
    for env in ("SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"):
        if os.environ.get(env) and pathlib.Path(os.environ[env]).exists():
            return ssl.create_default_context(cafile=os.environ[env])
    ccr = pathlib.Path("/root/.ccr/ca-bundle.crt")
    if ccr.exists():
        return ssl.create_default_context(cafile=str(ccr))
    return ssl.create_default_context()


def synthesize_mp3() -> pathlib.Path:
    """Return the cached MP3, calling the ElevenLabs API only when the cache is missing."""
    path = _cache_path()
    if path.exists() and path.stat().st_size > 10_000:
        return path
    key = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    if not key:
        raise RuntimeError(f"{path} is not cached and ELEVENLABS_API_KEY is not set")
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE['voice_id']}?output_format={OUTPUT_FORMAT}"
    req = urllib.request.Request(url, data=_request_body(), method="POST",
                                 headers={"xi-api-key": key, "Content-Type": "application/json", "Accept": "audio/mpeg"})
    with urllib.request.urlopen(req, timeout=180, context=_ssl_context()) as resp:
        data = resp.read()
    if len(data) < 10_000 or not (data[:3] == b"ID3" or data[0] == 0xFF):
        raise RuntimeError(f"unexpected TTS response ({len(data)} bytes)")
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".part")
    tmp.write_bytes(data)
    tmp.replace(path)
    return path


def encode_voice_ogg(mp3: pathlib.Path, out: pathlib.Path) -> None:
    af = "adelay=350:all=1,apad=pad_dur=0.6,highpass=f=90,lowpass=f=7800"
    cmd = [C.require_tool("ffmpeg"), "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(mp3),
           "-af", af, "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "24k", "-vbr", "on",
           "-application", "voip", "-frame_duration", "20", "-map_metadata", "-1",
           "-metadata", "title=ОБРАЗЕЦ / SPECIMEN — голосовое (синтез речи, все имена вымышлены)",
           "-fflags", "+bitexact", "-flags:a", "+bitexact", str(out)]
    subprocess.run(cmd, check=True, capture_output=True)


def probe(path: pathlib.Path) -> dict:
    res = subprocess.run([C.require_tool("ffprobe"), "-v", "error", "-show_entries",
                          "format=duration,format_name:stream=codec_name,sample_rate,channels",
                          "-of", "json", str(path)], check=True, capture_output=True, text=True)
    d = json.loads(res.stdout)
    st = d["streams"][0]
    return dict(container=d["format"]["format_name"], codec=st["codec_name"], sample_rate=int(st["sample_rate"]),
                channels=int(st["channels"]), duration_s=round(float(d["format"]["duration"]), 2))


def build(out_dir: pathlib.Path, truth_dir: pathlib.Path) -> list[str]:
    out_dir = pathlib.Path(out_dir)
    truth_dir = pathlib.Path(truth_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    mp3 = synthesize_mp3()
    out = out_dir / FIXTURE
    encode_voice_ogg(mp3, out)
    info = probe(out)
    if info["duration_s"] > 95:
        raise RuntimeError(f"voice message too long: {info['duration_s']} s")
    truth = dict(
        case=CASE,
        file=FIXTURE,
        mime="audio/ogg; codecs=opus",
        send_as="Telegram voice message",
        audio=dict(info, bitrate="24k", tts=dict(provider="ElevenLabs", model=MODEL, voice=VOICE,
                                                  seed=SEED, voice_settings=VOICE_SETTINGS,
                                                  cached_mp3=mp3.name,
                                                  cached_mp3_sha256=hashlib.sha256(mp3.read_bytes()).hexdigest())),
        transcript=TEXT,
        facts=FACTS,
        expected=EXPECTED,
        note=("Число учеников (25) в голосовом прямо не названо: «присутствовали восемнадцать родителей из двадцати "
              "пяти» — 25 семей, по одному ученику на семью; сбор считается с ученика."),
    )
    tpath = C.ff_write_json(truth_dir / "golosovoe.json", truth)
    return [str(out), tpath]


def verify_stt(path: pathlib.Path) -> str:
    """Verification only: transcribe the OGG with ElevenLabs speech-to-text (scribe_v1) via curl."""
    key = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    res = subprocess.run(["curl", "-sS", "-m", "180", "-X", "POST", "https://api.elevenlabs.io/v1/speech-to-text",
                          "-H", f"xi-api-key: {key}", "-F", "model_id=scribe_v1", "-F", "language_code=rus",
                          "-F", "tag_audio_events=false", "-F", f"file=@{path};type=audio/ogg"],
                         check=True, capture_output=True, text=True)
    return json.loads(res.stdout).get("text", res.stdout)


if __name__ == "__main__":
    base = HERE.parent
    for p in build(base / "out" / CASE, base / "truth"):
        print(p)
    if "--stt" in sys.argv:
        print(verify_stt(base / "out" / CASE / FIXTURE))
