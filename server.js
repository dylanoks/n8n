const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const axios = require("axios");
const { spawn } = require("child_process");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args);

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} failed with code ${code}\n${stderr}`));
      }
    });
  });
}

async function downloadFile(url, outputPath) {
  const response = await axios({
    method: "get",
    url,
    responseType: "stream",
  });

  const writer = fs.createWriteStream(outputPath);
  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

function randomPhrase(inputPhrase) {
  const phrases = [
    "youtube automation paid off",
    "larp or get larped",
    "larp so much you become the larp",
    "larpaholic",
    "yt automation so ez",
  ];
  return inputPhrase || phrases[Math.floor(Math.random() * phrases.length)];
}

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/render", async (req, res) => {
  const { sourceVideoUrl, audioUrl, phrase } = req.body;

  if (!sourceVideoUrl || !audioUrl) {
    return res.status(400).json({
      success: false,
      error: "Missing required fields: sourceVideoUrl, audioUrl, and phrase",
    });
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "render-"));
  const inputVideo = path.join(workDir, "input.mp4");
  const inputAudio = path.join(workDir, "audio.mp3");
  const outputVideo = path.join(workDir, "output.mp4");

  try {
    await downloadFile(sourceVideoUrl, inputVideo);
    await downloadFile(audioUrl, inputAudio);

    const chosenPhrase = randomPhrase(phrase);

    const ffmpegArgs = [
      "-y",
      "-i", inputVideo,
      "-i", inputAudio,
      "-t", "8",
      "-vf",
      `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,drawtext=text='${chosenPhrase.replace(/:/g, "\\:").replace(/'/g, "\\'")}':fontcolor=white:fontsize=72:x=(w-text_w)/2:y=(h-text_h)/2`,
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c:v", "libx264",
      "-c:a", "aac",
      "-shortest",
      outputVideo,
    ];

    await runCommand("ffmpeg", ffmpegArgs);

    const fileName = `reel-${Date.now()}.mp4`;
    const publicDir = path.join(__dirname, "outputs");
    if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

    const publicPath = path.join(publicDir, fileName);
    fs.copyFileSync(outputVideo, publicPath);

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const finalMp4Url = `${baseUrl}/outputs/${fileName}`;

    return res.json({
      success: true,
      finalMp4Url,
      phrase: chosenPhrase,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {}
  }
});

app.use("/outputs", express.static(path.join(__dirname, "outputs")));

app.listen(PORT, () => {
  console.log(`Render API running on port ${PORT}`);
});
