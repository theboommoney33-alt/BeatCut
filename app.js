/* ============================================================
   BeatCut — beat-synced video editor (vanilla JS, runs in-browser)
   ------------------------------------------------------------
   Structure:
     MediaLibrary  – holds uploaded photos/videos + play order
     BeatEngine     – maps song time -> which clip is on screen
     Renderer       – draws the active clip onto the canvas
     Exporter       – records canvas + audio to a .webm file
     App            – wires the UI together
   ============================================================ */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const fmtTime = (s) => {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const ASPECTS = {
    '16:9': [1280, 720],
    '9:16': [720, 1280],
    '1:1':  [720, 720],
    '4:5':  [720, 900],
  };

  /* ---------------------------------------------------------- */
  /*  MediaLibrary                                              */
  /* ---------------------------------------------------------- */
  class MediaLibrary {
    constructor() {
      this.items = []; // { id, type, name, url, el, ready }
      this._id = 0;
    }

    async add(file) {
      const type = file.type.startsWith('video') ? 'video' : 'image';
      const url = URL.createObjectURL(file);
      const item = { id: ++this._id, type, name: file.name, url, el: null, ready: false };

      await new Promise((resolve) => {
        if (type === 'image') {
          const img = new Image();
          img.onload = () => { item.el = img; item.ready = true; resolve(); };
          img.onerror = () => { item.ready = false; resolve(); };
          img.src = url;
        } else {
          const v = document.createElement('video');
          v.muted = true;          // we use the song for audio, not clip audio
          v.loop = true;           // loop clip if it's shorter than its on-screen slot
          v.playsInline = true;
          v.preload = 'auto';
          v.onloadeddata = () => { item.el = v; item.ready = true; resolve(); };
          v.onerror = () => { item.ready = false; resolve(); };
          v.src = url;
        }
      });

      if (item.ready) this.items.push(item);
      return item.ready ? item : null;
    }

    remove(id) {
      const i = this.items.findIndex((m) => m.id === id);
      if (i >= 0) {
        URL.revokeObjectURL(this.items[i].url);
        this.items.splice(i, 1);
      }
    }

    clear() {
      this.items.forEach((m) => URL.revokeObjectURL(m.url));
      this.items = [];
    }

    move(fromIndex, toIndex) {
      if (toIndex < 0 || toIndex >= this.items.length) return;
      const [it] = this.items.splice(fromIndex, 1);
      this.items.splice(toIndex, 0, it);
    }

    shuffle() {
      for (let i = this.items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.items[i], this.items[j]] = [this.items[j], this.items[i]];
      }
    }

    reverse() { this.items.reverse(); }

    get count() { return this.items.length; }
  }

  /* ---------------------------------------------------------- */
  /*  BeatEngine — time -> active clip                          */
  /* ---------------------------------------------------------- */
  class BeatEngine {
    constructor() {
      this.bpm = 120;
      this.beatsPerCut = 8;
    }

    get secondsPerBeat() { return 60 / this.bpm; }
    get secondsPerCut() { return this.secondsPerBeat * this.beatsPerCut; }

    // Which item (index into the order list) is showing at time t.
    clipIndexAt(t, itemCount) {
      if (itemCount === 0) return 0;
      const cut = Math.floor(t / this.secondsPerCut);
      return cut % itemCount;
    }

    // 0..1 progress through the current beat (for the punch effect).
    beatPhase(t) {
      const p = (t % this.secondsPerBeat) / this.secondsPerBeat;
      return p;
    }

    // True for a brief window right after a beat lands.
    isBeatHit(t) {
      return this.beatPhase(t) < 0.12;
    }
  }

  /* ---------------------------------------------------------- */
  /*  Renderer — draw active clip on the canvas                 */
  /* ---------------------------------------------------------- */
  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.punch = false; // off by default — media shown exactly as submitted
    }

    resize(w, h) { this.canvas.width = w; this.canvas.height = h; }

    clear() {
      this.ctx.fillStyle = '#000';
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }

    // Draw source fully inside the canvas (object-fit: contain), centered.
    // The whole photo/frame is shown as-is, never cropped or zoomed; any
    // leftover space is letterboxed in black.
    drawContain(source, sw, sh, zoom = 1) {
      const { ctx, canvas } = this;
      if (!sw || !sh) return;
      const scale = Math.min(canvas.width / sw, canvas.height / sh) * zoom;
      const dw = sw * scale, dh = sh * scale;
      const dx = (canvas.width - dw) / 2, dy = (canvas.height - dh) / 2;
      ctx.drawImage(source, dx, dy, dw, dh);
    }

    render(item, beatPhase) {
      this.clear();
      if (!item || !item.ready || !item.el) return;

      // Default zoom is 1 (untouched). Only the optional beat-punch toggle
      // applies a brief zoom pulse.
      let zoom = 1;
      if (this.punch) zoom = 1 + 0.06 * (1 - Math.min(beatPhase / 0.5, 1));

      const sw = item.type === 'image' ? item.el.naturalWidth : item.el.videoWidth;
      const sh = item.type === 'image' ? item.el.naturalHeight : item.el.videoHeight;
      this.drawContain(item.el, sw, sh, zoom);
    }
  }

  /* ---------------------------------------------------------- */
  /*  Exporter — record canvas + song into a downloadable file  */
  /* ---------------------------------------------------------- */
  class Exporter {
    constructor(canvas, audioEl) {
      this.canvas = canvas;
      this.audioEl = audioEl;
      this.audioCtx = null;
      this.sourceNode = null;
      this.destNode = null;
    }

    _ensureAudioGraph() {
      // A MediaElementSource can only be created once per element, so cache it.
      if (this.audioCtx) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AC();
      this.sourceNode = this.audioCtx.createMediaElementSource(this.audioEl);
      this.destNode = this.audioCtx.createMediaStreamDestination();
      this.sourceNode.connect(this.destNode);            // -> recording
      this.sourceNode.connect(this.audioCtx.destination); // -> speakers
    }

    pickMime() {
      const cands = [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
      ];
      return cands.find((c) => MediaRecorder.isTypeSupported(c)) || 'video/webm';
    }

    // Returns a MediaRecorder + a promise that resolves with the Blob on stop.
    start(fps = 30) {
      this._ensureAudioGraph();
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume();

      const videoStream = this.canvas.captureStream(fps);
      const stream = new MediaStream([
        ...videoStream.getVideoTracks(),
        ...this.destNode.stream.getAudioTracks(),
      ]);

      const mime = this.pickMime();
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

      const done = new Promise((resolve) => {
        rec.onstop = () => resolve(new Blob(chunks, { type: mime }));
      });

      rec.start(100);
      return { rec, done };
    }
  }

  /* ---------------------------------------------------------- */
  /*  BPMDetector — estimate tempo from an audio file           */
  /*  Decodes the song, low-passes it to isolate the kick/bass, */
  /*  finds energy peaks, then looks for the most common spacing */
  /*  between peaks and folds it into a musical 90–180 range.    */
  /* ---------------------------------------------------------- */
  const BPMDetector = {
    async detect(arrayBuffer) {
      const AC = window.AudioContext || window.webkitAudioContext;
      const tmp = new AC();
      let audioBuffer;
      try {
        audioBuffer = await tmp.decodeAudioData(arrayBuffer.slice(0));
      } finally {
        tmp.close();
      }

      // Render through a band of filters that emphasise the beat.
      const offline = new OfflineAudioContext(1, audioBuffer.length, audioBuffer.sampleRate);
      const src = offline.createBufferSource();
      src.buffer = audioBuffer;
      const lowpass = offline.createBiquadFilter();
      lowpass.type = 'lowpass'; lowpass.frequency.value = 150; lowpass.Q.value = 1;
      const highpass = offline.createBiquadFilter();
      highpass.type = 'highpass'; highpass.frequency.value = 100; highpass.Q.value = 1;
      src.connect(lowpass); lowpass.connect(highpass); highpass.connect(offline.destination);
      src.start(0);

      const rendered = await offline.startRendering();
      const data = rendered.getChannelData(0);

      const peaks = this._peaks(data);
      if (peaks.length < 2) return null;
      const intervals = this._intervals(peaks);
      const tempos = this._tempos(intervals, rendered.sampleRate);
      if (!tempos.length) return null;
      tempos.sort((a, b) => b.count - a.count);
      return tempos[0].tempo;
    },

    _peaks(data) {
      let max = 0;
      for (let i = 0; i < data.length; i++) {
        const v = Math.abs(data[i]);
        if (v > max) max = v;
      }
      if (max === 0) return [];
      // Lower the threshold until we collect enough peaks to be meaningful.
      let peaks = [];
      let threshold = max * 0.9;
      while (peaks.length < 30 && threshold >= max * 0.2) {
        peaks = this._peaksAt(data, threshold);
        threshold -= max * 0.05;
      }
      return peaks;
    },

    _peaksAt(data, threshold) {
      const peaks = [];
      const skip = 10000; // ~0.23s @44.1k — avoid double-counting one hit
      for (let i = 0; i < data.length;) {
        if (Math.abs(data[i]) > threshold) { peaks.push(i); i += skip; }
        else i++;
      }
      return peaks;
    },

    _intervals(peaks) {
      const counts = [];
      peaks.forEach((peak, index) => {
        for (let i = 0; i < 10; i++) {
          const interval = peaks[index + i] - peak;
          if (!interval) continue;
          const found = counts.find((c) => c.interval === interval);
          if (found) found.count++;
          else counts.push({ interval, count: 1 });
        }
      });
      return counts;
    },

    _tempos(intervals, sampleRate) {
      const tempos = [];
      intervals.forEach((ic) => {
        if (ic.interval === 0) return;
        let t = 60 / (ic.interval / sampleRate);
        while (t < 90) t *= 2;
        while (t > 180) t /= 2;
        t = Math.round(t);
        const found = tempos.find((x) => x.tempo === t);
        if (found) found.count += ic.count;
        else tempos.push({ tempo: t, count: ic.count });
      });
      return tempos;
    },
  };

  /* ---------------------------------------------------------- */
  /*  App — UI wiring + playback loop                           */
  /* ---------------------------------------------------------- */
  class App {
    constructor() {
      this.library = new MediaLibrary();
      this.engine = new BeatEngine();
      this.canvas = $('canvas');
      this.renderer = new Renderer(this.canvas);
      this.audio = new Audio();
      this.audio.preload = 'auto';
      this.exporter = new Exporter(this.canvas, this.audio);

      this.playing = false;
      this.exporting = false;
      this.rafId = null;
      this.activeIndex = -1; // index into library.items currently shown

      // Timeline driven by a master clock (seconds), independent of the song.
      this.clock = 0;          // current playback position
      this._lastTs = null;     // last rAF timestamp, for delta timing
      this.duration = 0;       // total output length (seconds)
      this.durationMode = 'passes'; // 'passes' | 'song' | 'custom'
      this.passesTarget = 2;   // default: go through every photo twice

      this._loop = this._loop.bind(this);
      this._bindUI();
      this._setAspect('16:9');
      this._updateCutLabel();
    }

    /* ---------- UI binding ---------- */
    _bindUI() {
      // Media upload + drag/drop
      const mediaDrop = $('mediaDrop');
      $('mediaInput').addEventListener('change', (e) => this._onMediaFiles(e.target.files));
      this._enableDrop(mediaDrop, (files) => this._onMediaFiles(files), 'image/video');

      // Audio upload + drag/drop
      $('audioInput').addEventListener('change', (e) => this._onAudioFile(e.target.files[0]));
      this._enableDrop($('audioDrop'), (files) => this._onAudioFile(files[0]), 'audio');
      $('detectBpmBtn').addEventListener('click', () => this.detectBPM());

      // Song source tabs
      $('songTabFile').addEventListener('click', () => this._setSongTab('file'));
      $('songTabYT').addEventListener('click', () => this._setSongTab('yt'));
      this._checkServerHealth();
      $('ytLoadBtn').addEventListener('click', () => this._onYouTubeURL($('ytUrlInput').value.trim()));
      $('ytUrlInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this._onYouTubeURL($('ytUrlInput').value.trim());
      });

      // Order tools
      $('shuffleBtn').addEventListener('click', () => { this.library.shuffle(); this._renderList(); });
      $('reverseBtn').addEventListener('click', () => { this.library.reverse(); this._renderList(); });
      $('clearMediaBtn').addEventListener('click', () => {
        this.library.clear(); this._renderList(); this._recomputeDuration(); this._refreshState();
      });

      // BPM + cut frequency
      $('bpmInput').addEventListener('input', (e) => {
        this.engine.bpm = Math.max(20, parseFloat(e.target.value) || 120);
        this._updateCutLabel();
      });
      $('beatsPerCut').addEventListener('input', (e) => {
        this.engine.beatsPerCut = parseInt(e.target.value, 10);
        $('beatsLabel').textContent = this.engine.beatsPerCut;
        this._updateCutLabel();
      });
      $('aspect').addEventListener('change', (e) => this._setAspect(e.target.value));
      $('punchFx').addEventListener('change', (e) => { this.renderer.punch = e.target.checked; });

      // Video length
      $('lengthInput').addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        this.durationMode = 'custom';
        if (v > 0) {
          this.duration = v;
          if (this.clock > this.duration) this.clock = this.duration;
        }
        this._updateLengthUI();
      });
      $('len1x').addEventListener('click', () => {
        this.durationMode = 'passes'; this.passesTarget = 1; this._recomputeDuration();
      });
      $('len2x').addEventListener('click', () => {
        this.durationMode = 'passes'; this.passesTarget = 2; this._recomputeDuration();
      });
      $('lenSong').addEventListener('click', () => {
        if (!isFinite(this.audio.duration) || this.audio.duration <= 0) {
          $('lengthInfo').textContent = 'Add a song first to match its length.';
          return;
        }
        this.durationMode = 'song'; this._recomputeDuration();
      });

      // Tap tempo
      this._taps = [];
      $('tapBtn').addEventListener('click', () => this._onTap());

      // Transport
      $('playBtn').addEventListener('click', () => this.togglePlay());
      $('stopBtn').addEventListener('click', () => this.stop());
      $('seek').addEventListener('input', (e) => {
        if (!this.duration) return;
        this.clock = (e.target.value / 1000) * this.duration;
        try { this.audio.currentTime = this._audioPosFor(this.clock); } catch (_) {}
        this._drawFrame();
        $('curTime').textContent = fmtTime(this.clock);
      });

      // Recompute length once we know the song's duration.
      this.audio.addEventListener('loadedmetadata', () => {
        this._recomputeDuration();
        this._refreshState();
      });

      // Export
      $('exportBtn').addEventListener('click', () => this.export());
    }

    _enableDrop(zone, handler, kind) {
      ['dragenter', 'dragover'].forEach((ev) =>
        zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('drag'); }));
      ['dragleave', 'drop'].forEach((ev) =>
        zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('drag'); }));
      zone.addEventListener('drop', (e) => {
        const files = [...e.dataTransfer.files].filter((f) => {
          if (kind === 'audio') return f.type.startsWith('audio');
          return f.type.startsWith('image') || f.type.startsWith('video');
        });
        if (files.length) handler(files);
      });
    }

    /* ---------- Song source tabs ---------- */
    _setSongTab(tab) {
      $('songPanelFile').hidden = tab !== 'file';
      $('songPanelYT').hidden = tab !== 'yt';
      $('songTabFile').classList.toggle('active', tab === 'file');
      $('songTabYT').classList.toggle('active', tab === 'yt');
      if (tab === 'yt') this._checkServerHealth();
    }

    async _checkServerHealth() {
      const dot = $('serverDot');
      const label = $('serverStatusText');
      try {
        const r = await fetch('http://localhost:7474/health', { signal: AbortSignal.timeout(2000) });
        if (r.ok) {
          dot.className = 'server-dot online';
          label.textContent = 'Local server: online — fast downloads via yt-dlp';
          return;
        }
      } catch (_) {}
      dot.className = 'server-dot offline';
      label.textContent = 'Local server offline — run: docker-compose up -d in editor/backend/';
    }

    async _onYouTubeURL(url) {
      if (!url) return;

      const idMatch = url.match(/(?:v=|youtu\.be\/)([^&?#]{11})/);
      if (!idMatch) {
        $('ytStatus').textContent = 'Enter a valid YouTube watch URL.';
        $('ytStatus').className = 'detect-status';
        return;
      }
      const videoId = idMatch[1];

      $('ytStatus').className = 'detect-status working';
      $('ytLoadBtn').disabled = true;

      try {
        const { blob, title } = await this._fetchYTAudio(videoId);

        if (this.audio.src && this.audio.src.startsWith('blob:')) URL.revokeObjectURL(this.audio.src);
        this.audio.src = URL.createObjectURL(blob);
        this.audioFile = blob;

        $('audioName').textContent = title || url;
        $('detectBpmBtn').disabled = false;
        $('ytStatus').textContent = 'Loaded! Detecting BPM…';
        this._refreshState();
        this.detectBPM();
      } catch (err) {
        $('ytStatus').textContent = `Failed: ${err.message}`;
        $('ytStatus').className = 'detect-status';
      } finally {
        $('ytLoadBtn').disabled = false;
      }
    }

    async _fetchYTAudio(videoId) {
      const isCDN = url => /googlevideo\.com|youtube\.com\/videoplayback/.test(url);

      // Try local yt-dlp server first (start it with: cd backend && docker-compose up -d)
      try {
        $('ytStatus').textContent = 'Trying local server…';
        const lr = await fetch(`http://localhost:7474/audio?v=${videoId}`, {
          signal: AbortSignal.timeout(60000),
        });
        if (lr.ok) {
          const blob = await lr.blob();
          if (blob.size > 8192) {
            return { blob, title: lr.headers.get('X-Title') || videoId };
          }
        }
      } catch (_) {}

      // Fetch live Invidious instances that advertise CORS + API support, sorted by health.
      // Falls back to hardcoded list if the meta-API is unreachable.
      $('ytStatus').textContent = 'Finding available instances…';
      let invidiousInstances = [];
      try {
        const r = await fetch('https://api.invidious.io/instances.json?sort_by=health', {
          signal: AbortSignal.timeout(6000),
        });
        if (r.ok) {
          const list = await r.json();
          invidiousInstances = list
            .filter(([, info]) => info.api && info.cors && info.uri?.startsWith('https'))
            .slice(0, 6)
            .map(([, info]) => info.uri.replace(/\/$/, ''));
        }
      } catch (_) {}

      if (!invidiousInstances.length) {
        invidiousInstances = [
          'https://invidious.privacyredirect.com',
          'https://yt.artemislena.eu',
          'https://inv.tux.pizza',
          'https://invidious.io',
          'https://invidious.fdn.fr',
        ];
      }

      let lastError = 'no instances responded';

      // --- Invidious with local=true (proxied URLs, CORS-safe) ---
      for (const base of invidiousInstances) {
        const host = new URL(base).hostname;
        $('ytStatus').textContent = `Trying ${host}…`;
        let data;
        try {
          const r = await fetch(`${base}/api/v1/videos/${videoId}?local=true`, {
            signal: AbortSignal.timeout(12000),
          });
          if (!r.ok) { lastError = `${host}: HTTP ${r.status}`; continue; }
          data = await r.json();
          if (data.error) { lastError = `${host}: ${data.error}`; continue; }
        } catch (e) { lastError = `${host}: ${e.message}`; continue; }

        const streams = (data.adaptiveFormats || [])
          .filter(f => f.type?.startsWith('audio/'))
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        if (!streams.length) { lastError = `${host}: no audio streams`; continue; }

        const streamUrl = streams[0].url;
        if (isCDN(streamUrl)) { lastError = `${host}: returned unproxied CDN URL`; continue; }

        $('ytStatus').textContent = `Downloading from ${host}…`;
        try {
          const r = await fetch(streamUrl, { signal: AbortSignal.timeout(90000) });
          if (!r.ok) { lastError = `${host}: stream HTTP ${r.status}`; continue; }
          const blob = await r.blob();
          if (blob.size < 8192) { lastError = `${host}: too small (${blob.size}B)`; continue; }
          return { blob, title: data.title };
        } catch (e) { lastError = `${host}: ${e.message}`; continue; }
      }

      // --- Piped fallback (only usable if instance returns a proxied, non-CDN URL) ---
      const PIPED = [
        'https://pipedapi.kavin.rocks',
        'https://piped-api.garudalinux.org',
        'https://pipedapi.in.projectsegfau.lt',
      ];
      for (const base of PIPED) {
        const host = new URL(base).hostname;
        $('ytStatus').textContent = `Trying ${host}…`;
        let data;
        try {
          const r = await fetch(`${base}/streams/${videoId}`, { signal: AbortSignal.timeout(12000) });
          if (!r.ok) { lastError = `${host}: HTTP ${r.status}`; continue; }
          data = await r.json();
          if (data.error) { lastError = `${host}: ${data.error}`; continue; }
        } catch (e) { lastError = `${host}: ${e.message}`; continue; }

        const streams = (data.audioStreams || []).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        if (!streams.length) { lastError = `${host}: no audio streams`; continue; }

        const streamUrl = streams[0].url;
        if (isCDN(streamUrl)) { lastError = `${host}: returned unproxied CDN URL`; continue; }

        $('ytStatus').textContent = `Downloading from ${host}…`;
        try {
          const r = await fetch(streamUrl, { signal: AbortSignal.timeout(90000) });
          if (!r.ok) { lastError = `${host}: stream HTTP ${r.status}`; continue; }
          const blob = await r.blob();
          if (blob.size < 8192) { lastError = `${host}: too small (${blob.size}B)`; continue; }
          return { blob, title: data.title };
        } catch (e) { lastError = `${host}: ${e.message}`; continue; }
      }

      throw new Error(lastError);
    }

    /* ---------- File handlers ---------- */
    async _onMediaFiles(fileList) {
      const files = [...fileList];
      $('statusText').textContent = `Loading ${files.length} file(s)…`;
      for (const f of files) await this.library.add(f);
      this._renderList();
      this._recomputeDuration();
      this._refreshState();
    }

    _onAudioFile(file) {
      if (!file) return;
      if (this.audio.src) URL.revokeObjectURL(this.audio.src);
      const url = URL.createObjectURL(file);
      this.audio.src = url;
      this.audioFile = file;
      $('audioName').textContent = file.name;
      $('detectBpmBtn').disabled = false;
      this._refreshState();
      // Find the BPM automatically as soon as a song is loaded.
      this.detectBPM();
    }

    /* ---------- BPM auto-detection ---------- */
    async detectBPM() {
      if (!this.audioFile) return;
      const status = $('detectStatus');
      const btn = $('detectBpmBtn');
      status.textContent = 'Analyzing the song…';
      status.className = 'detect-status working';
      btn.disabled = true;
      try {
        const buf = await this.audioFile.arrayBuffer();
        const bpm = await BPMDetector.detect(buf);
        if (bpm) {
          this.engine.bpm = bpm;
          $('bpmInput').value = bpm;
          this._updateCutLabel();
          status.textContent = `Detected ≈ ${bpm} BPM (adjust above if needed)`;
          status.className = 'detect-status found';
          this._refreshState();
        } else {
          status.textContent = 'Couldn’t detect a clear beat — enter or TAP the BPM.';
          status.className = 'detect-status';
        }
      } catch (err) {
        status.textContent = 'Detection failed — enter or TAP the BPM.';
        status.className = 'detect-status';
      } finally {
        btn.disabled = false;
      }
    }

    /* ---------- Media list rendering + reordering ---------- */
    _renderList() {
      const list = $('mediaList');
      list.innerHTML = '';
      $('mediaCount').textContent = `${this.library.count} item${this.library.count === 1 ? '' : 's'}`;

      this.library.items.forEach((item, idx) => {
        const li = document.createElement('li');
        li.className = 'media-item';
        li.draggable = true;
        li.dataset.index = idx;

        const num = document.createElement('span');
        num.className = 'mi-index';
        num.textContent = idx + 1;

        const thumb = document.createElement(item.type === 'video' ? 'video' : 'img');
        thumb.className = 'mi-thumb';
        thumb.src = item.url;
        if (item.type === 'video') { thumb.muted = true; }

        const meta = document.createElement('div');
        meta.className = 'mi-meta';
        meta.innerHTML = `<div class="mi-name">${item.name}</div><div class="mi-type">${item.type}</div>`;

        const actions = document.createElement('div');
        actions.className = 'mi-actions';
        const up = this._iconBtn('↑', 'Move up', () => { this.library.move(idx, idx - 1); this._renderList(); });
        const down = this._iconBtn('↓', 'Move down', () => { this.library.move(idx, idx + 1); this._renderList(); });
        const del = this._iconBtn('✕', 'Remove', () => { this.library.remove(item.id); this._renderList(); this._recomputeDuration(); this._refreshState(); });
        actions.append(up, down, del);

        li.append(num, thumb, meta, actions);
        this._attachDragHandlers(li);
        list.appendChild(li);
      });
    }

    _iconBtn(label, title, onClick) {
      const b = document.createElement('button');
      b.className = 'mi-btn';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', onClick);
      return b;
    }

    _attachDragHandlers(li) {
      li.addEventListener('dragstart', (e) => {
        this._dragFrom = +li.dataset.index;
        li.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      li.addEventListener('dragend', () => li.classList.remove('dragging'));
      li.addEventListener('dragover', (e) => { e.preventDefault(); li.classList.add('over'); });
      li.addEventListener('dragleave', () => li.classList.remove('over'));
      li.addEventListener('drop', (e) => {
        e.preventDefault();
        li.classList.remove('over');
        const to = +li.dataset.index;
        if (this._dragFrom != null && this._dragFrom !== to) {
          this.library.move(this._dragFrom, to);
          this._renderList();
        }
        this._dragFrom = null;
      });
    }

    /* ---------- Tap tempo ---------- */
    _onTap() {
      const now = performance.now();
      this._taps = this._taps.filter((t) => now - t < 2500);
      this._taps.push(now);
      if (this._taps.length >= 2) {
        const spans = [];
        for (let i = 1; i < this._taps.length; i++) spans.push(this._taps[i] - this._taps[i - 1]);
        const avg = spans.reduce((a, b) => a + b, 0) / spans.length;
        const bpm = Math.round((60000 / avg) * 10) / 10;
        this.engine.bpm = bpm;
        $('bpmInput').value = bpm;
        this._updateCutLabel();
      }
    }

    /* ---------- Helpers ---------- */
    _setAspect(key) {
      const [w, h] = ASPECTS[key];
      this.renderer.resize(w, h);
      this._drawFrame();
    }

    _updateCutLabel() {
      $('cutSeconds').textContent = `each clip ≈ ${this.engine.secondsPerCut.toFixed(2)}s`;
      this._recomputeDuration();
    }

    _audioPosFor(t) {
      const songDur = this.audio.duration;
      return (isFinite(songDur) && songDur > 0) ? (t % songDur) : t;
    }

    // Work out the total output length from the current mode.
    _recomputeDuration() {
      const count = this.library.count;
      const secPerCut = this.engine.secondsPerCut;
      const songDur = (isFinite(this.audio.duration) && this.audio.duration > 0) ? this.audio.duration : 0;

      if (this.durationMode === 'passes') {
        this.duration = count > 0 ? this.passesTarget * count * secPerCut : 0;
      } else if (this.durationMode === 'song') {
        if (songDur > 0) this.duration = songDur;
      }
      // 'custom' keeps whatever the user typed.

      if (this.clock > this.duration) this.clock = this.duration;
      this._updateLengthUI();
    }

    _updateLengthUI() {
      const count = this.library.count;
      const secPerCut = this.engine.secondsPerCut;
      const cuts = secPerCut > 0 ? Math.round(this.duration / secPerCut) : 0;
      const passes = (count > 0 && secPerCut > 0) ? this.duration / (count * secPerCut) : 0;

      // Don't clobber the input while the user is actively typing in it.
      if (this.durationMode !== 'custom' && document.activeElement !== $('lengthInput')) {
        $('lengthInput').value = this.duration ? this.duration.toFixed(1) : '';
      }
      $('lengthInfo').textContent =
        `${fmtTime(this.duration)} · ≈ ${passes.toFixed(1)} passes · ${cuts} cuts`;
      $('totTime').textContent = fmtTime(this.duration);

      ['len1x', 'len2x', 'lenSong'].forEach((id) => $(id).classList.remove('active'));
      if (this.durationMode === 'passes' && this.passesTarget === 1) $('len1x').classList.add('active');
      if (this.durationMode === 'passes' && this.passesTarget === 2) $('len2x').classList.add('active');
      if (this.durationMode === 'song') $('lenSong').classList.add('active');
    }

    _refreshState() {
      const ready = this.library.count > 0 && !!this.audio.src;
      $('playBtn').disabled = !ready;
      $('stopBtn').disabled = !ready;
      $('seek').disabled = !ready;
      $('exportBtn').disabled = !ready;
      $('emptyOverlay').style.display = this.library.count > 0 ? 'none' : 'flex';

      if (ready) {
        $('statusText').textContent =
          `Ready · ${this.library.count} clips · ${this.engine.bpm} BPM · cut every ${this.engine.beatsPerCut} beats`;
        if (this.activeIndex < 0) this._drawFrame();
      } else if (this.library.count > 0 && !this.audio.src) {
        $('statusText').textContent = 'Now add a song.';
      } else if (this.library.count === 0 && this.audio.src) {
        $('statusText').textContent = 'Now add some photos or videos.';
      } else {
        $('statusText').textContent = 'Add media and a song to begin.';
      }
    }

    /* ---------- Playback loop ---------- */
    togglePlay() {
      if (this.playing) this.pause();
      else this.play();
    }

    play() {
      if (this.library.count === 0 || !this.audio.src || this.duration <= 0) return;
      if (this.clock >= this.duration - 1e-3) this.clock = 0; // restart from the top
      this.playing = true;
      $('playBtn').textContent = '❚❚ Pause';

      // If the video is longer than the song, loop the song so there's always sound.
      const songDur = this.audio.duration;
      this.audio.loop = isFinite(songDur) && this.duration > songDur + 0.1;
      try { this.audio.currentTime = this._audioPosFor(this.clock); } catch (_) {}
      this.audio.play().catch(() => {});

      this._lastTs = null;
      cancelAnimationFrame(this.rafId);
      this.rafId = requestAnimationFrame(this._loop);
    }

    pause() {
      this.playing = false;
      this._lastTs = null;
      $('playBtn').textContent = '▶ Play';
      this.audio.pause();
      this._pauseActiveVideo();
      cancelAnimationFrame(this.rafId);
    }

    stop() {
      const wasExporting = this.exporting;
      this.pause();
      this.clock = 0;
      try { this.audio.currentTime = 0; } catch (_) {}
      this.activeIndex = -1;
      this._drawFrame();
      $('seek').value = 0;
      $('curTime').textContent = '0:00';
      if (wasExporting) this._finishExport();
    }

    // Reached the end of the configured length.
    _onEnd() {
      this.playing = false;
      this._lastTs = null;
      $('playBtn').textContent = '▶ Play';
      this.audio.pause();
      this._pauseActiveVideo();
      cancelAnimationFrame(this.rafId);
      if (this.exporting) this._finishExport();
    }

    _loop(ts) {
      if (!this.playing) return;
      if (this._lastTs != null) this.clock += (ts - this._lastTs) / 1000;
      this._lastTs = ts;

      if (this.clock >= this.duration) {
        this.clock = this.duration;
        this._drawFrame();
        this._updateTransport();
        this._onEnd();
        return;
      }
      this._drawFrame();
      this._updateTransport();
      this.rafId = requestAnimationFrame(this._loop);
    }

    _updateTransport() {
      const d = this.duration || 1;
      $('seek').value = Math.min(1000, (this.clock / d) * 1000);
      $('curTime').textContent = fmtTime(this.clock);
    }

    // Decide which clip is active at the current clock time, drive video els, draw.
    _drawFrame() {
      const items = this.library.items;
      if (items.length === 0) { this.renderer.clear(); return; }

      const t = this.clock;
      const idx = this.engine.clipIndexAt(t, items.length);

      if (idx !== this.activeIndex) {
        this._pauseActiveVideo();
        this.activeIndex = idx;
        const item = items[idx];
        if (item && item.type === 'video' && item.el) {
          try { item.el.currentTime = 0; } catch (_) {}
          if (this.playing || this.exporting) item.el.play().catch(() => {});
        }
      }

      const item = items[this.activeIndex];
      this.renderer.render(item, this.engine.beatPhase(t));

      // beat indicator dot
      const dot = $('beatDot');
      if (this.engine.isBeatHit(t)) dot.classList.add('hit');
      else dot.classList.remove('hit');
    }

    _pauseActiveVideo() {
      const item = this.library.items[this.activeIndex];
      if (item && item.type === 'video' && item.el) item.el.pause();
    }

    /* ---------- Export ---------- */
    async export() {
      if (this.exporting) return;
      const ready = this.library.count > 0 && this.audio.src;
      if (!ready) return;

      this.exporting = true;
      $('exportBtn').disabled = true;
      $('downloadLink').hidden = true;
      $('exportProgress').hidden = false;
      $('exportLabel').textContent = 'Recording…';
      $('statusText').textContent = 'Exporting — let it play to the end.';

      // Start from the top.
      this.clock = 0;
      this.activeIndex = -1;
      const songDur = this.audio.duration;
      this.audio.loop = isFinite(songDur) && this.duration > songDur + 0.1;
      try { this.audio.currentTime = 0; } catch (_) {}

      const { rec, done } = this.exporter.start(30);
      this._activeRecorder = rec;
      this._exportDone = done;

      // Update progress while it records.
      this._progressTimer = setInterval(() => {
        if (!this.exporting) return;
        const pct = Math.min(100, (this.clock / (this.duration || 1)) * 100);
        $('exportBar').style.width = pct + '%';
        $('exportLabel').textContent = `Recording… ${Math.floor(pct)}%`;
      }, 200);

      // Play through; the master clock reaching duration triggers _onEnd -> _finishExport.
      this.playing = true;
      this.audio.play().catch(() => {});
      this._lastTs = null;
      cancelAnimationFrame(this.rafId);
      this.rafId = requestAnimationFrame(this._loop);
    }

    async _finishExport() {
      if (!this._activeRecorder) return;
      clearInterval(this._progressTimer);
      const rec = this._activeRecorder;
      this._activeRecorder = null;
      this.exporting = false;

      if (rec.state !== 'inactive') rec.stop();
      const blob = await this._exportDone;

      const url = URL.createObjectURL(blob);
      const link = $('downloadLink');
      link.href = url;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      link.download = `beatcut-${stamp}.webm`;
      link.textContent = '⬇ Save your video';
      link.hidden = false;

      $('exportBar').style.width = '100%';
      $('exportLabel').textContent = 'Done! Click “Save your video”.';
      $('exportBtn').disabled = false;
      $('statusText').textContent = 'Export complete.';

      // Auto-trigger download as a convenience.
      link.click();
    }
  }

  /* ---------- boot ---------- */
  window.addEventListener('DOMContentLoaded', () => {
    if (!('MediaRecorder' in window)) {
      $('statusText').textContent = 'Your browser does not support video export (MediaRecorder).';
    }
    window.beatcut = new App();
  });
})();
