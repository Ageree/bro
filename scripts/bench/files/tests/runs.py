"""Builds a bench run directory the way the driver leaves it (files-run.json + received/), for tests and simulations."""

from __future__ import annotations

import hashlib
import json
import pathlib
import shutil

PDF = "application/pdf"


def make_run(root, case_id: str, *, files=(), replies=(), questions=(), gates=(), failed=(),
             started_at: str = "2026-10-15T09:00:00Z", time_zone: str = "Europe/Moscow",
             manifest_sha: str | None = None) -> pathlib.Path:
    """files: (turn, source path or bytes, name[, at]); replies: (turn, text[, at]); questions: (turn, prompt);
    gates: (turn, met, question); failed: (turn, url path). Returns the case directory."""
    case_dir = pathlib.Path(root) / case_id
    if case_dir.exists():
        shutil.rmtree(case_dir)
    received_dir = case_dir / "received"
    received_dir.mkdir(parents=True)
    received = []
    for seq, entry in enumerate(files, start=1):
        turn, source, name = entry[:3]
        at = entry[3] if len(entry) > 3 else started_at
        data = source if isinstance(source, bytes) else pathlib.Path(source).read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        ext = pathlib.PurePosixPath(name).suffix.lower()
        rel = f"received/{'c' if turn is None else turn}-{seq}-{digest[:8]}{ext}"
        (case_dir / rel).write_bytes(data)
        received.append({"turn": turn, "at": at, "name": name, "shownName": None, "mediaType": _media(ext),
                         "bytes": len(data), "sha256": digest, "file": rel, "source": "attachment",
                         "urlPath": f"/eve/v1/sandbox-files/{digest[:24]}/{name}"})
    run = {
        "version": 1, "caseId": case_id, "startedAt": started_at, "timeZone": time_zone, "host": "https://test.invalid",
        "fixtures": {"dir": "", "manifestSha256": manifest_sha},
        "turns": [],
        "gates": [{"turn": g[0], "kind": "consent", "optional": False, "met": g[1], "question": g[2]} for g in gates],
        "pendingGate": None,
        "replies": [{"turn": r[0], "at": r[2] if len(r) > 2 else started_at, "text": r[1], "attachments": 0,
                     "sessionId": "s"} for r in replies],
        "questions": [{"turn": q[0], "at": started_at, "prompt": q[1]} for q in questions],
        "received": received,
        "failedDownloads": [{"turn": f[0], "urlPath": f[1], "reason": "HTTP 500"} for f in failed],
    }
    (case_dir / "files-run.json").write_text(json.dumps(run, ensure_ascii=False, indent=1), encoding="utf-8")
    return case_dir


def _media(ext: str) -> str:
    return {".pdf": PDF, ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            ".zip": "application/zip", ".ics": "text/calendar", ".vcf": "text/vcard"}.get(ext, "application/octet-stream")
