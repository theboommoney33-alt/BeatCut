from flask import Flask, request, Response
from flask_cors import CORS
import yt_dlp, tempfile, shutil, os

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

@app.route('/health')
def health():
    return 'ok'

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=7474)
