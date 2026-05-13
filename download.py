import sys
import os
import yt_dlp

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

youtube_url   = os.environ.get('YOUTUBE_URL')
download_path = os.environ.get('DOWNLOAD_PATH')

if not youtube_url or not download_path:
    print('ERROR: YOUTUBE_URL and DOWNLOAD_PATH environment variables are required', flush=True)
    sys.exit(1)

os.makedirs(download_path, exist_ok=True)

SEP = '─' * 60

def progress_hook(d):
    if d['status'] == 'downloading':
        pct   = d.get('_percent_str', '?').strip()
        speed = d.get('_speed_str',   '?').strip()
        eta   = d.get('_eta_str',     '?').strip()
        print(f'  {pct}  {speed}  ETA {eta}', flush=True)
    elif d['status'] == 'finished':
        print(f'  Finished: {os.path.basename(d["filename"])}', flush=True)


# ── Audio ──────────────────────────────────────────────────────────────────
print(SEP, flush=True)
print('Downloading audio (best quality)...', flush=True)

audio_opts = {
    'format': 'bestaudio/best',
    'outtmpl': os.path.join(download_path, '%(title)s.%(ext)s'),
    'progress_hooks': [progress_hook],
    'quiet': True,
    'no_warnings': False,
}

try:
    with yt_dlp.YoutubeDL(audio_opts) as ydl:
        info = ydl.extract_info(youtube_url, download=True)
        ext = info.get('ext', 'webm')
        print(f'✓ Audio saved: {info.get("title", "unknown")}.{ext}', flush=True)
except Exception as e:
    print(f'✗ Audio download failed: {e}', flush=True)
    sys.exit(1)


# ── Thumbnail ──────────────────────────────────────────────────────────────
print(SEP, flush=True)
print('Downloading thumbnail...', flush=True)

thumb_opts = {
    'skip_download': True,
    'writethumbnail': True,
    'outtmpl': os.path.join(download_path, '%(title)s.%(ext)s'),
    'quiet': True,
    'no_warnings': False,
}

try:
    with yt_dlp.YoutubeDL(thumb_opts) as ydl:
        ydl.download([youtube_url])
    print('✓ Thumbnail saved', flush=True)
except Exception as e:
    print(f'✗ Thumbnail download failed: {e}', flush=True)


print(SEP, flush=True)
print('✓ All done!', flush=True)
