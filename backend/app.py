from __future__ import annotations

import os
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

import yt_dlp
from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent
DOWNLOAD_DIR = BASE_DIR / "downloads"
DOWNLOAD_DIR.mkdir(exist_ok=True)

# Local-only starter. Keep this allowlist narrow; add providers deliberately.
ALLOWED_HOSTS = {
    "youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "music.youtube.com",
    "tiktok.com", "www.tiktok.com", "vm.tiktok.com", "vt.tiktok.com",
    "instagram.com", "www.instagram.com",
}

app = FastAPI(title="MediaDrop API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5500", "http://localhost:5500", "null"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

jobs: dict[str, dict] = {}
lock = threading.Lock()

class InspectRequest(BaseModel):
    url: str = Field(min_length=8, max_length=2048)

class DownloadRequest(BaseModel):
    url: str = Field(min_length=8, max_length=2048)
    format: Literal["mp3", "mp4"] = "mp4"
    quality: str = Field(default="best", pattern=r"^(best|2160p|1440p|1080p|720p|480p|360p|320k|192k|128k)$")


def validate_url(raw: str) -> str:
    raw = raw.strip()
    parsed = urlparse(raw)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise HTTPException(400, "Masukkan URL http/https yang valid.")
    host = parsed.hostname.lower().rstrip(".")
    if host not in ALLOWED_HOSTS:
        raise HTTPException(400, "Sumber ini belum diaktifkan di starter ini.")
    if parsed.username or parsed.password:
        raise HTTPException(400, "URL dengan kredensial tidak diperbolehkan.")
    return raw


def ydl_base_options() -> dict:
    return {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "socket_timeout": 20,
        "retries": 2,
        "extractor_retries": 1,
    }

@app.get("/api/health")
def health():
    return {"status": "ok", "service": "mediadrop-api"}

@app.post("/api/inspect")
def inspect_media(body: InspectRequest):
    url = validate_url(body.url)
    opts = {**ydl_base_options(), "skip_download": True}
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as exc:
        # Keep internal traceback/details out of the client response.
        raise HTTPException(422, "Metadata gagal diambil. Periksa URL atau coba sumber lain.") from exc
    if not info:
        raise HTTPException(422, "Metadata tidak ditemukan.")
    formats = info.get("formats") or []
    heights = sorted({f.get("height") for f in formats if f.get("height")}, reverse=True)
    return {
        "id": str(info.get("id") or uuid.uuid4()),
        "url": url,
        "title": info.get("title") or "Untitled media",
        "thumbnail": info.get("thumbnail"),
        "duration": info.get("duration"),
        "uploader": info.get("uploader") or info.get("channel") or "Unknown source",
        "extractor": info.get("extractor_key") or info.get("extractor") or "Media source",
        "webpage_url": info.get("webpage_url") or url,
        "available_heights": heights,
        "has_audio": any(f.get("acodec") not in (None, "none") for f in formats),
        "has_video": any(f.get("vcodec") not in (None, "none") for f in formats),
    }


def quality_format(fmt: str, quality: str) -> tuple[str, list[dict]]:
    if fmt == "mp3":
        bitrate = quality[:-1] if quality.endswith("k") else "192"
        return "bestaudio/best", [{"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": bitrate}]
    if quality == "best":
        return "bestvideo*+bestaudio/best", []
    height = int(quality[:-1])
    return f"bestvideo[height<={height}]+bestaudio/best[height<={height}]/best", []


def run_download(job_id: str, url: str, fmt: str, quality: str) -> None:
    outtmpl = str(DOWNLOAD_DIR / f"{job_id}_%(title).80B.%(ext)s")
    selector, postprocessors = quality_format(fmt, quality)
    def hook(data: dict):
        with lock:
            job = jobs.get(job_id)
            if not job:
                return
            status = data.get("status")
            if status == "downloading":
                total = data.get("total_bytes") or data.get("total_bytes_estimate")
                done = data.get("downloaded_bytes") or 0
                job["progress"] = min(99, int(done * 100 / total)) if total else None
                job["speed"] = data.get("_speed_str")
                job["eta"] = data.get("_eta_str")
                job["message"] = "Downloading"
            elif status == "finished":
                job["progress"] = 99
                job["message"] = "Processing media"
    opts = {
        **ydl_base_options(),
        "format": selector,
        "outtmpl": outtmpl,
        "progress_hooks": [hook],
        "postprocessors": postprocessors,
        "merge_output_format": "mp4" if fmt == "mp4" else None,
        "overwrites": False,
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([url])
        candidates = [p for p in DOWNLOAD_DIR.glob(f"{job_id}_*") if p.is_file() and not p.name.endswith((".part", ".ytdl"))]
        if not candidates:
            raise RuntimeError("Output file not found")
        final_path = max(candidates, key=lambda p: p.stat().st_mtime)
        with lock:
            jobs[job_id].update(status="completed", progress=100, message="Ready", filename=final_path.name)
    except Exception:
        with lock:
            jobs[job_id].update(status="failed", message="Download gagal. Coba kualitas lain atau periksa dukungan sumber.")

@app.post("/api/downloads")
def create_download(body: DownloadRequest, background_tasks: BackgroundTasks):
    url = validate_url(body.url)
    job_id = uuid.uuid4().hex
    with lock:
        jobs[job_id] = {
            "id": job_id, "status": "queued", "progress": 0, "message": "Queued",
            "format": body.format, "quality": body.quality, "created_at": time.time(),
        }
    background_tasks.add_task(run_download, job_id, url, body.format, body.quality)
    return {"id": job_id, "status": "queued"}

@app.get("/api/downloads/{job_id}")
def get_download(job_id: str):
    with lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(404, "Job tidak ditemukan.")
        result = dict(job)
    if result.get("status") == "completed":
        result["download_url"] = f"/api/downloads/{job_id}/file"
    return result

@app.get("/api/downloads/{job_id}/file")
def download_file(job_id: str):
    with lock:
        job = jobs.get(job_id)
        filename = job.get("filename") if job else None
    if not filename:
        raise HTTPException(404, "File belum tersedia.")
    path = (DOWNLOAD_DIR / filename).resolve()
    if path.parent != DOWNLOAD_DIR.resolve() or not path.is_file():
        raise HTTPException(404, "File tidak ditemukan.")
    safe_name = re.sub(r"[^\w.() -]", "_", filename.split("_", 1)[-1])
    return FileResponse(path, filename=safe_name, media_type="application/octet-stream")
