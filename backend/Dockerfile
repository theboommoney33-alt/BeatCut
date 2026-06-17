FROM python:3.12-slim
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir flask flask-cors yt-dlp
WORKDIR /app
COPY server.py .
CMD ["python", "server.py"]
