# Instagram Reel Generator API

Automated API that takes a source video + audio file, randomly extracts short clips,
concatenates them into a vertical 1080×1920 Instagram Reel with text overlay and
custom audio, then returns a public URL to the finished MP4.

---

## How It Works

```
Source Video ──→ ffprobe (get duration)
                   │
                   ▼
            Pick N random timestamps
                   │
                   ▼
            Extract N × 0.8s clips (ffmpeg)
                   │
                   ▼
            Concatenate clips (ffmpeg concat demuxer)
                   │
                   ▼
            Overlay text + replace audio (ffmpeg)
                   │
                   ▼
            Serve finished MP4 at /outputs/<id>.mp4
```

---

## Prerequisites

- **Node.js** ≥ 18
- **ffmpeg** and **ffprobe** installed and on `$PATH`

### Install ffmpeg

```bash
# Ubuntu / Debian
sudo apt-get install ffmpeg

# macOS
brew install ffmpeg

# Alpine
apk add ffmpeg
```

---

## Quick Start (Local)

```bash
# 1. Clone / copy this project
cd reel-generator

# 2. Install dependencies
npm install

# 3. Start the server
npm start
# → 🚀 Instagram Reel Generator API running at http://localhost:3000
```

---

## API Reference

### `GET /health`

Returns server status and active job count.

```json
{ "status": "ok", "activeJobs": 0 }
```

### `POST /render`

Generate a reel. All three fields marked **required** must be present.

#### Request Body

| Field            | Type   | Default | Description                                     |
| ---------------- | ------ | ------- | ----------------------------------------------- |
| `sourceVideoUrl` | string | —       | **(required)** URL to the source video file      |
| `audioUrl`       | string | —       | **(required)** URL to the audio file             |
| `phrase`         | string | —       | **(required)** Text overlay displayed on the reel |
| `clipCount`      | number | 10      | Number of random clips to extract                |
| `clipDuration`   | number | 0.8     | Duration of each clip in seconds                 |
| `finalDuration`  | number | 8       | Expected total duration (for documentation)      |
| `width`          | number | 1080    | Output width in pixels                           |
| `height`         | number | 1920    | Output height in pixels                          |

#### Success Response (200)

```json
{
  "success": true,
  "jobId": "a1b2c3d4-...",
  "finalMp4Url": "https://your-host.com/outputs/reel_a1b2c3d4-....mp4",
  "meta": {
    "clips": 10,
    "clipDuration": 0.8,
    "totalDuration": 8,
    "resolution": "1080x1920",
    "phrase": "larp or get larped"
  }
}
```

#### Error Response (400 / 500 / 503)

```json
{
  "success": false,
  "error": "Descriptive error message"
}
```

---

## Example cURL Request

```bash
curl -X POST http://localhost:3000/render \
  -H "Content-Type: application/json" \
  -d '{
    "sourceVideoUrl": "https://example.com/sample-video.mp4",
    "audioUrl": "https://example.com/background-music.mp3",
    "phrase": "larp or get larped",
    "clipCount": 10,
    "clipDuration": 0.8,
    "finalDuration": 8,
    "width": 1080,
    "height": 1920
  }'
```

---

## FFmpeg Commands Explained

The API runs four FFmpeg passes per job. Here is the exact logic for each.

### 1. Extract a single clip

```bash
ffmpeg \
  -ss <START_SECONDS> \        # Seek to random position (fast, before -i)
  -i source_video.mp4 \        # Input file
  -t 0.8 \                     # Trim to exactly 0.8 seconds
  -vf "scale=1080:1920:force_original_aspect_ratio=decrease, \
       pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black, \
       setsar=1" \              # Scale to 1080×1920 with black letterbox
  -c:v libx264 \               # H.264 encoding
  -preset fast \
  -crf 23 \
  -an \                         # Remove original audio
  -r 30 \                       # Normalize to 30 fps
  -pix_fmt yuv420p \
  -y clip_000.mp4
```

This is run **10 times** (once per random start time). Each clip gets its own
output file (`clip_000.mp4` through `clip_009.mp4`).

### 2. Concatenate all clips

```bash
# First write a concat list file:
# file '/tmp/<jobid>/clip_000.mp4'
# file '/tmp/<jobid>/clip_001.mp4'
# ...

ffmpeg \
  -f concat \                   # Use concat demuxer
  -safe 0 \                     # Allow absolute paths
  -i concat_list.txt \
  -c copy \                     # No re-encode (clips are already uniform)
  -y concatenated.mp4
```

### 3. Final render (text overlay + audio replace)

```bash
ffmpeg \
  -i concatenated.mp4 \                          # Video input
  -stream_loop -1 -i audio_input.mp3 \           # Audio input (loops if short)
  -t 8 \                                          # Trim to 8 seconds
  -vf "scale=1080:1920:force_original_aspect_ratio=decrease, \
       pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black, \
       setsar=1, \
       drawtext=fontfile='/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf': \
         text='larp or get larped': \
         fontsize=52: \
         fontcolor=white: \
         borderw=3:bordercolor=black: \
         shadowcolor=black@0.5:shadowx=2:shadowy=2: \
         x=(w-text_w)/2: \
         y=(h-text_h)/2" \
  -map 0:v:0 \                 # Take video from input 0
  -map 1:a:0 \                 # Take audio from input 1
  -c:v libx264 -preset fast -crf 20 \
  -c:a aac -b:a 192k -ar 44100 -ac 2 \
  -r 30 -pix_fmt yuv420p \
  -movflags +faststart \        # Enable progressive download
  -y output.mp4
```

---

## Environment Variables

| Variable              | Default                  | Description                          |
| --------------------- | ------------------------ | ------------------------------------ |
| `PORT`                | `3000`                   | HTTP listen port                     |
| `HOST`                | `0.0.0.0`               | HTTP listen address                  |
| `BASE_URL`            | `http://localhost:3000`  | Public base URL for download links   |
| `MAX_CONCURRENT_JOBS` | `3`                      | Max simultaneous render jobs         |

---

## Deployment

### Option A: Railway

1. Push this repo to GitHub.
2. Go to [railway.app](https://railway.app), create a new project, and connect your repo.
3. Railway auto-detects the Dockerfile.
4. Add environment variables in the Railway dashboard:
   - `BASE_URL` = your Railway-assigned domain (e.g., `https://reel-gen-production.up.railway.app`)
5. Deploy. Railway will build the Docker image and start the service.
6. Your endpoint will be `https://<your-domain>/render`.

> **Note:** Railway's free tier has limited disk. The `/outputs` directory is
> ephemeral — files survive until the next deploy. For persistent storage,
> integrate an S3-compatible bucket (see "Cloud Storage Upgrade" below).

### Option B: Render

1. Push this repo to GitHub.
2. Go to [render.com](https://render.com), create a new **Web Service**, and connect your repo.
3. Set the following:
   - **Runtime:** Docker
   - **Instance type:** Starter or Standard (needs enough RAM for ffmpeg)
4. Add environment variable:
   - `BASE_URL` = your Render service URL (e.g., `https://reel-gen.onrender.com`)
5. Deploy.

> **Render disks are ephemeral on free tier.** Attach a Render Disk
> mounted at `/app/outputs` if you need persistence, or use cloud storage.

### Option C: Any VPS / Docker Host

```bash
# Build the image
docker build -t reel-generator .

# Run it
docker run -d \
  --name reel-gen \
  -p 3000:3000 \
  -e BASE_URL=https://yourdomain.com \
  -v reel-outputs:/app/outputs \
  reel-generator
```

---

## Cloud Storage Upgrade

The default setup serves files from Express's static middleware. For production
you'll likely want to upload to S3, R2, GCS, etc. To do this:

1. Install the relevant SDK (e.g., `@aws-sdk/client-s3`).
2. After the final ffmpeg render, upload `outputPath` to your bucket.
3. Return the bucket's public URL instead of the Express URL.
4. Delete the local file after upload.

The code is structured so that step 12 (URL construction) is easy to swap out.

---

## Project Structure

```
reel-generator/
├── server.js         # Main API — all logic in one file
├── package.json      # Dependencies
├── Dockerfile        # Production container
├── .dockerignore
├── README.md         # This file
├── outputs/          # Finished MP4s (auto-created, served by Express)
└── tmp/              # Per-job temp files (auto-created, auto-cleaned)
```

---

## License

MIT
