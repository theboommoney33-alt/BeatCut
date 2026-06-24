# BeatCut

Beat-synced video editor that runs entirely in the browser. Drop in photos and video clips, load a song, and the editor automatically cuts between them on the beat. Export to MP4 via a local Docker backend.

---

## Features

| # | Feature | Notes |
|---|---------|-------|
| 1 | **Media upload** | Photos (jpg/png/gif) and video clips (mp4/webm/mov). Drag-and-drop reorder. Shuffle / Reverse / Clear. |
| 2 | **Song loading** | Upload a local audio file, or paste a YouTube URL (requires backend). |
| 3 | **YouTube audio** | Backend pulls audio via `yt-dlp`. Frontend falls back to public Invidious/Piped instances if backend is offline. |
| 4 | **BPM detection** | Auto-detects on load. Manual override via number input. Tap-tempo button. |
| 5 | **Cut frequency** | Range slider: cut every N beats (1–64). Live preview updates as you drag. |
| 6 | **Video length** | 1× or 2× through all photos, match song duration, or type a custom length in seconds. |
| 7 | **Aspect ratio** | Range slider: 9:16 (TikTok/Reels) → 4:5 (Instagram) → 1:1 (Square) → 16:9 (YouTube). Canvas resizes live. |
| 8 | **Beat punch zoom** | Subtle zoom-in on each beat hit. Off by default. |
| 9 | **Ken Burns effect** | Slow zoom + pan on photos. Intensity slider. Center-zoom-only toggle (no pan). |
| 10 | **Transitions** | Cut, Dissolve, Fade to black, Flash (white), Zoom punch, Slide wipe. Duration slider (0.1s–1.5s). |
| 11 | **Song start offset** | Slider to begin playback partway through the song (e.g., start at the chorus). Appears once a song is loaded. |
| 12 | **Fade out** | Linearly fades music volume to 0 over the last N seconds. Duration 1–10s. |
| 13 | **Export to MP4** | Records canvas + audio via `MediaRecorder` (WebM), then POSTs to backend for FFmpeg → H.264 MP4 conversion. Falls back to WebM if backend is offline. |

---

## Project structure

```
editor/
├── index.html          # All markup — 4 input cards + preview stage
├── styles.css          # Dark theme, CSS variables, no framework
├── app.js              # All frontend logic (~1300 lines, vanilla JS)
└── backend/
    ├── server.py       # Flask server — /audio, /convert, /health
    ├── Dockerfile      # python:3.12-slim + ffmpeg + yt-dlp
    ├── docker-compose.yml
    └── requirements.txt
```

---

## Running the backend

The backend is optional — the editor works without it (YouTube loading falls back to public proxies, export falls back to WebM). But for reliable YouTube downloads and MP4 export, run:

```bash
cd editor/backend
docker compose up --build -d
```

Backend listens on **`http://localhost:7474`**. The frontend auto-detects it via `/health` on load and on the YouTube tab.

To stop: `docker compose down`

---

## Backend API

### `GET /health`
Returns `ok`. Used by the frontend to detect whether the backend is running.

### `GET /audio?v=<videoId>`
Downloads best-quality audio for a YouTube video ID via `yt-dlp`.
- Returns raw audio bytes with `Content-Type: audio/<ext>` and `X-Title` header containing the video title.
- Video ID is validated (max 16 chars, no path traversal).

### `POST /convert`
Converts a WebM blob to H.264 MP4 via FFmpeg.
- Body: `multipart/form-data` with field `file` containing the WebM blob.
- FFmpeg flags: `-c:v libx264 -preset fast -crf 22 -c:a aac -b:a 192k -movflags +faststart`
- Returns MP4 bytes. Timeout: 600s.
- On failure: returns FFmpeg stderr as plain text with status 500.

---

## Frontend architecture (`app.js`)

Four classes wired together by `App`:

### `MediaLibrary`
Holds the ordered list of uploaded photos/videos. Each item is `{ id, type, name, url, el, ready }` where `el` is an `<img>` or `<video>` element. Video elements are muted (song provides audio) and set to `loop: true` so a short clip fills its entire cut slot.

### `BeatEngine`
Stateless time-to-clip mapper.
- `secondsPerCut = (60 / bpm) * beatsPerCut`
- `clipIndexAt(t, count)` → `Math.floor(t / secondsPerCut) % count`
- `beatPhase(t)` → 0..1 position within the current beat (used for punch zoom)

### `Renderer`
Draws one frame onto the canvas.
- `drawContain(source, sw, sh, zoom)` — object-fit: contain with optional zoom. Uses `Math.min` scale (never crops).
- `drawKenBurns(...)` — 4 presets cycling by clip index (zoom-in/drift-right, zoom-in/drift-up, zoom-out/drift-left, zoom-out/drift-down). `kenBurnsCenter = true` zeroes the pan component.
- `_drawSingle(item, clipProgress, clipIndex, beatPhase)` — draws one item without clearing (used by transition blending).
- `renderTransition(from, to, progress, ...)` — blends two clips for the active transition type.

**Transition rendering:**
- `dissolve` / `fade` — `ctx.globalAlpha`
- `flash` — white `fillRect` at `globalAlpha = 1 - |2*progress - 1|`
- `zoom` — `ctx.save / translate / scale / restore` on the incoming clip
- `slide` — clip-rect wipe (left half = from, right half = to, seam moves with progress). Avoids gaps from letterboxed images.

### `Exporter`
Wraps `MediaRecorder`. Captures the canvas stream + an `AudioContext` destination node fed from the `<audio>` element. Records at 8 Mbps VP9/VP8. Returns a `Blob` via promise on `stop`.

### `App`
Master controller.
- **Master clock** (`this.clock`): advances via `requestAnimationFrame` delta. Independent of `audio.currentTime`; audio is synced at play-start and on scrubber drag only.
- **`_audioPosFor(t)`**: `songStart + (t % (songDur - songStart))` — handles looping from the song start offset.
- **Transition detection in `_drawFrame`**: nearest cut point = `Math.round(t / secPerCut) * secPerCut`. Transition active when `|t - cutTime| <= transD / 2`. `transProgress = (t - cutTime + halfTrans) / transD` maps 0→1. Active video switches to `toIdx` at `transProgress >= 0.5`.
- **Fade out**: `_loop` sets `audio.volume = max(0, 1 - (clock - fadeStart) / fadeOutDuration)`. Reset to 1 on stop/end.
- **Song start looping**: when `songStart > 0`, `audio.loop = false` and an `ended` listener manually seeks back to `songStart` and calls `play()`.

---

## Key design decisions

**Contain scale everywhere** — all drawing uses `Math.min(canvasW / srcW, canvasH / srcH)` (contain), never `Math.max` (cover). Photos are always fully visible with letterboxing. This was a deliberate fix from an earlier version that cropped portrait images on landscape canvases.

**Canvas-clip wipe for slide** — a physical slide (moving images left/right) creates visible black gaps for letterboxed content. Instead, the slide transition uses `ctx.beginPath / rect / clip` to split the canvas into left/right halves, drawing the from-clip on the left and the to-clip on the right with a moving seam.

**No framework** — the whole editor is a single vanilla JS IIFE. No build step, no bundler. Open `index.html` directly in a browser.

**Export flow**: record (WebM) → POST to `/convert` → download MP4. If backend unreachable, download WebM. The WebM falls back silently so the export button always works.

---

## Known limitations / future work

- Export is real-time (must play through once while recording). No faster-than-realtime render.
- YouTube fallback via public Invidious/Piped instances is unreliable; backend is strongly preferred.
- `audio.loop` with `songStart > 0` is managed manually via the `ended` event; there may be a ~100ms gap at the loop point depending on device.
- No 4:3 aspect ratio option (common for presentations).
- Transition preview in the scrubber works but transition timing depends on BPM — very fast BPM + long transition duration will overlap adjacent transitions.
