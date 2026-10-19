# MediaDrop — local media utility

A local-first media downloader UI and FastAPI backend designed to run in Termux.

## Requirements
- Termux with Python installed
- A working virtual environment in `backend/.venv`
- Python packages from `backend/requirements.txt`

The pinned FastAPI/Pydantic combination is selected for the ARM/Android environment used during development. If pip cannot install a package on your exact Python build, do not upgrade everything blindly; check the install error first.

## Start backend
```bash
cd ~/projects/mediadrop/backend
source .venv/bin/activate
python -m pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8000
```

## Start frontend
Open another Termux session:
```bash
cd ~/projects/mediadrop/frontend
python -m http.server 8080 --bind 127.0.0.1
```

Open `http://127.0.0.1:8080` in your phone browser. API docs: `http://127.0.0.1:8000/docs`.

## Included in this package
- Redesigned responsive dark UI with a restrained green accent
- URL input rows, paste button, URL inspection and per-item output controls
- Queue cards, status polling and download result action
- Light theme toggle saved in local browser storage
- Existing starter FastAPI/yt-dlp API contract retained

## Notes
- This is a frontend redesign plus small compatibility fixes, not the full future roadmap.
- Job persistence, cancellation, a full media library, FFmpeg conversion, and a real scheduler are not implemented in this release.
- Download only content you own or have permission to save, and respect each platform's terms.
- Keep the backend bound to `127.0.0.1` unless you deliberately configure and secure network access.
