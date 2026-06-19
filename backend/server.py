from flask import Flask, request, Response
from flask_cors import CORS
import yt_dlp, tempfile, shutil, os, subprocess

app = Flask(__name__)
CORS(app, expose_headers=['X-Title'])

@app.route('/audio')
def audio():
    vid = request.args.get('v', '').strip()
    if not vid or len(vid) > 16:
        return 'invalid id', 400

    tmpdir = tempfile.mkdtemp()
    try:
        opts = {
            'format': 'bestaudio[ext=webm]/bestaudio/best',
            'outtmpl': os.path.join(tmpdir, 'audio.%(ext)s'),
            'quiet': True,
            'no_warnings': True,
        }
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f'https://youtube.com/watch?v={vid}')

        files = os.listdir(tmpdir)
        if not files:
            return 'download failed', 500

        path = os.path.join(tmpdir, files[0])
        ext = os.path.splitext(files[0])[1].lstrip('.') or 'webm'
        title = info.get('title', vid)

        with open(path, 'rb') as f:
            data = f.read()

        return Response(
            data,
            mimetype=f'audio/{ext}',
            headers={'X-Title': title.encode('ascii', 'replace').decode()}
        )
    except Exception as e:
        return str(e), 500
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

@app.route('/convert', methods=['POST'])
def convert():
    webm = request.files.get('file')
    if not webm:
        return 'no file', 400

    tmpdir = tempfile.mkdtemp()
    try:
        in_path  = os.path.join(tmpdir, 'input.webm')
        out_path = os.path.join(tmpdir, 'output.mp4')
        webm.save(in_path)

        result = subprocess.run(
            [
                'ffmpeg', '-y', '-i', in_path,
                '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
                '-c:a', 'aac', '-b:a', '192k',
                '-movflags', '+faststart',
                out_path,
            ],
            capture_output=True,
            timeout=600,
        )
        if result.returncode != 0:
            return result.stderr.decode(errors='replace'), 500

        with open(out_path, 'rb') as f:
            data = f.read()

        return Response(
            data,
            mimetype='video/mp4',
            headers={'Content-Disposition': 'attachment; filename="beatcut.mp4"'},
        )
    except Exception as e:
        return str(e), 500
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

@app.route('/health')
def health():
    return 'ok'

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=7474)
