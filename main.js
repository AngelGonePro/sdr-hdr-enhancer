const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.loadFile('index.html');
  win.webContents.openDevTools();
  return win;
}

function createVideoWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 950,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.loadFile('video.html');
  return win;
}

// Gets the exact duration of a specific stream via ffprobe, for Duration
// Correction — ported directly from the audio converter tool's validated
// implementation. Fixes a real class of AV sync problem where a source
// AC3/audio stream's actual decoded content is measurably shorter than the
// video's true runtime (a property of how the source was originally
// encoded, confirmed via direct sample-count testing there — not
// something introduced by this tool's processing). Uses -select_streams
// combined with format=duration (not stream=duration) deliberately: this
// forces ffprobe to compute duration from the selected stream's actual
// timing rather than trust a stream-level duration field that could be
// exactly the unreliable value this feature exists to correct for.
ipcMain.handle('get-duration', async (event, payload) => {
  return new Promise((resolve) => {
    const ffmpegPath = payload.ffmpeg;
    const filePath = payload.filePath;
    const streamIndex = payload.streamIndex != null ? payload.streamIndex : 'a:0';
    const ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, (m, ext) => 'ffprobe' + (ext || ''));

    const args = ['-v', 'error', '-select_streams', String(streamIndex), '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath];
    let proc;
    try {
      proc = spawn(ffprobePath, args, { windowsHide: true });
    } catch (err) {
      resolve({ error: String(err && err.message || err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", d => stdout += d.toString());
    proc.stderr.on("data", d => stderr += d.toString());
    proc.on("close", code => {
      if (code !== 0) {
        resolve({ error: stderr || `ffprobe exited with code ${code}` });
        return;
      }
      const duration = parseFloat(stdout.trim());
      resolve({ duration: Number.isNaN(duration) ? null : duration });
    });
    proc.on("error", err => {
      resolve({ error: err.message });
    });
  });
});

// Detects source video quality: resolution, framerate, audio channel count,
// and whether the source is already HDR (checked via color transfer
// characteristic — smpte2084/arib-std-b67 indicate HDR, anything else is
// treated as SDR) — same auto-detection philosophy as the audio tool's
// channel-count/duration detection, applied to video.
ipcMain.handle('get-video-info', async (event, payload) => {
  return new Promise((resolve) => {
    const ffmpegPath = payload.ffmpeg;
    const filePath = payload.filePath;
    const ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, (m, ext) => 'ffprobe' + (ext || ''));

    const args = [
      '-v', 'error',
      '-show_entries', 'stream=index,width,height,r_frame_rate,codec_type,channels,color_transfer,codec_name,pix_fmt',
      '-show_entries', 'stream_tags=language,title',
      '-show_entries', 'format=duration',
      '-of', 'json',
      filePath
    ];
    let proc;
    try {
      proc = spawn(ffprobePath, args, { windowsHide: true });
    } catch (err) {
      resolve({ error: String(err && err.message || err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", d => stdout += d.toString());
    proc.stderr.on("data", d => stderr += d.toString());
    proc.on("close", code => {
      if (code !== 0) {
        resolve({ error: stderr || `ffprobe exited with code ${code}` });
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        const streams = parsed.streams || [];
        const videoStreams = streams.filter(s => s.codec_type === 'video').map(s => ({
          index: s.index,
          codec: s.codec_name,
          width: s.width,
          height: s.height,
          frameRate: s.r_frame_rate,
          colorTransfer: s.color_transfer,
          pixFmt: s.pix_fmt,
          title: (s.tags && s.tags.title) || null
        }));
        const videoStream = videoStreams[0]; // first, for backward-compatible fields below
        const audioStreams = streams.filter(s => s.codec_type === 'audio').map(s => ({
          index: s.index,
          codec: s.codec_name,
          channels: s.channels,
          language: (s.tags && s.tags.language) || 'und',
          title: (s.tags && s.tags.title) || null
        }));
        const subtitleStreams = streams.filter(s => s.codec_type === 'subtitle').map(s => ({
          index: s.index,
          codec: s.codec_name,
          language: (s.tags && s.tags.language) || 'und',
          title: (s.tags && s.tags.title) || null
        }));
        resolve({
          width: videoStream ? videoStream.width : null,
          height: videoStream ? videoStream.height : null,
          frameRate: videoStream ? videoStream.frameRate : null,
          videoCodec: videoStream ? videoStream.codec : null,
          colorTransfer: videoStream ? videoStream.colorTransfer : null,
          videoStreams,
          audioStreams,
          subtitleStreams,
          // kept for backward compatibility with existing quality-display code
          audioChannels: audioStreams.length > 0 ? audioStreams[0].channels : null,
          duration: parsed.format ? parseFloat(parsed.format.duration) : null
        });
      } catch (e) {
        resolve({ error: 'Failed to parse ffprobe output: ' + e.message });
      }
    });
    proc.on("error", err => resolve({ error: err.message }));
  });
});

// Builds the correct GPU decode flags for detection sampling, per vendor —
// researched directly rather than assumed, since the three vendors use
// genuinely different ffmpeg hwaccel methods: NVIDIA via cuda, Intel via
// qsv, AMD via d3d11va (a Windows vendor-neutral API — the right choice
// for AMD specifically since AMF itself is an encoder interface, not a
// decode hwaccel name in ffmpeg's own -hwaccel list). cropdetect and
// signalstats themselves have no GPU-accelerated version for any vendor
// (confirmed against ffmpeg's own filter list), so all three still need
// hwdownload,format=nv12 before the actual CPU-side filter — only the
// decode step itself moves to the GPU.
function buildDetectionHwaccelArgs(gpuVendor, sourcePixFmt){
  // hwdownload needs an EXPLICIT format matching the real native surface
  // format — confirmed via research (and a real, reproduced failure) that
  // it does NOT auto-negotiate against a downstream filter's request; it
  // tries to satisfy that request directly during download, which fails
  // outright for any format the surface doesn't actually hold. A 10-bit
  // source decodes to a p010 surface, not nv12 — hardcoding either one
  // unconditionally fails for the other bit depth. Determine the correct
  // native format from the source's own pixel format instead.
  const is10Bit = !!(sourcePixFmt && /10le|10be|p010|p016|12le|12be/i.test(sourcePixFmt));
  const nativeFormat = is10Bit ? 'p010le' : 'nv12';
  if (gpuVendor === 'nvidia') return { pre: ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'], vfPrefix: `hwdownload,format=${nativeFormat},` };
  if (gpuVendor === 'intel') return { pre: ['-hwaccel', 'qsv'], vfPrefix: `hwdownload,format=${nativeFormat},` };
  if (gpuVendor === 'amd') return { pre: ['-hwaccel', 'd3d11va', '-hwaccel_output_format', 'd3d11'], vfPrefix: `hwdownload,format=${nativeFormat},` };
  return { pre: [], vfPrefix: '' };
}

// Auto-detects letterbox black bars the same way HandBrake does — samples
// cropdetect across the video (not just one frame, which can be thrown off
// by an all-black or unusually bright scene) and returns the crop value
// that appeared most consistently, plus how many samples agreed with it.
ipcMain.handle('detect-crop', async (event, payload) => {
  return new Promise((resolve) => {
    const ffmpegPath = payload.ffmpeg;
    const filePath = payload.filePath;
    const duration = payload.duration || 0;

    // Sample across the middle 80% of the film, skipping opening/closing
    // logos or black intro/outro frames that could skew detection.
    const startOffset = duration > 60 ? Math.max(30, duration * 0.1) : 0;
    const sampleDuration = duration > 60 ? Math.min(120, duration * 0.5) : Math.min(duration, 10);

    // cropdetect itself has no GPU-accelerated version (confirmed against
    // ffmpeg's own filter list — only separate filters like bilateral_cuda
    // exist, not a cropdetect_cuda), but the DECODE step feeding it can be
    // offloaded to reduce CPU load specifically for this sampling pass.
    const hwaccel = buildDetectionHwaccelArgs(payload.gpuVendor, payload.sourcePixFmt);
    const args = [
      ...hwaccel.pre,
      '-ss', String(startOffset),
      '-i', filePath,
      '-t', String(sampleDuration),
      // -map added here — this was previously missing entirely, meaning
      // crop detection always analyzed whichever video stream ffmpeg
      // defaults to (the first one), not the track actually selected in
      // the UI. For a file with multiple video tracks (like a pre-existing
      // HDR encode alongside the original SDR source), this could crop-
      // detect against completely the wrong track's framing.
      ...(payload.videoTrackIndex != null ? ['-map', `0:${payload.videoTrackIndex}`] : []),
      // format=yuv420p forces a consistent 8-bit scale before analysis —
      // confirmed directly via a real report: without this, an HDR (10-bit
      // PQ) source failed crop detection entirely, since cropdetect's
      // limit=24 threshold is calibrated for an 8-bit (0-255) scale and
      // was being compared against raw 10-bit (0-1023) PQ values instead —
      // a genuine known black bar tested this way came back as "no crop
      // needed" (missed entirely), matching what a real user reported.
      // Same fix already applied to brightness analysis below for the
      // same underlying reason.
      '-vf', hwaccel.vfPrefix + 'format=yuv420p,cropdetect=limit=24:round=2:reset=1',
      '-f', 'null', '-'
    ];
    let proc;
    try {
      proc = spawn(ffmpegPath, args, { windowsHide: true });
      // Registered under a fixed key (not a jobId) so a newer detection
      // call can kill this one via the same kill-ffmpeg-job handler the
      // Stop button uses — confirmed via a real report: without this, a
      // stale detection for a track the user had already switched away
      // from kept running to completion in the background, burning CPU
      // for no reason even after its result became irrelevant.
      activeProcesses.set('crop-detect', proc);
    } catch (err) {
      resolve({ error: String(err && err.message || err) });
      return;
    }
    let stderr = "";
    proc.stderr.on("data", d => stderr += d.toString());
    proc.on("close", (code) => {
      activeProcesses.delete('crop-detect');
      // Confirmed via a real report: a genuine process failure (e.g. GPU
      // hwaccel decode failing to initialize for this specific source)
      // was being silently masked as "no crop values detected" — the
      // same zero-matches outcome that a genuinely un-letterboxed video
      // produces. A non-zero exit code or explicit error text in stderr
      // means the sampling never actually ran, which is a materially
      // different problem the user needs to see, not this generic message.
      if (code !== 0) {
        const errorLines = stderr.split('\n').filter(l => /error|failed|cannot|unable|invalid|device creation/i.test(l));
        const detail = errorLines.length > 0 ? errorLines.slice(0, 2).join(' | ') : stderr.trim().slice(-300);
        resolve({ error: `Crop detection process failed (exit code ${code})${detail ? ': ' + detail : ''}` });
        return;
      }
      const matches = stderr.match(/crop=\d+:\d+:\d+:\d+/g) || [];
      if (matches.length === 0) {
        resolve({ error: 'No crop values detected — source may have no letterboxing, or detection sample was too short' });
        return;
      }
      const counts = {};
      for (const m of matches) counts[m] = (counts[m] || 0) + 1;
      const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      const [bestCrop, bestCount] = sorted[0];
      const [, w, h, x, y] = bestCrop.match(/crop=(\d+):(\d+):(\d+):(\d+)/);
      resolve({
        crop: { width: parseInt(w), height: parseInt(h), x: parseInt(x), y: parseInt(y) },
        confidence: bestCount / matches.length,
        totalSamples: matches.length
      });
    });
    proc.on("error", err => resolve({ error: err.message }));
  });
});

// Samples real luma statistics across the source (same sampling window as
// crop detection) to find the ACTUAL peak brightness the content uses —
// not the theoretical 255 maximum. Real footage rarely hits pure white at
// full saturation the way a synthetic worst-case test does, so this finds
// how much real headroom exists before recommending an HDR expansion
// target, instead of a single fixed default that has to assume the worst
// case for every source. Uses a high percentile (not the raw single-frame
// max) so one unusual bright frame — a lens flare, a title card — doesn't
// skew the result the way a true max() would.
ipcMain.handle('analyze-brightness', async (event, payload) => {
  return new Promise((resolve) => {
    const ffmpegPath = payload.ffmpeg;
    const filePath = payload.filePath;
    const duration = payload.duration || 0;

    const startOffset = duration > 60 ? Math.max(30, duration * 0.1) : 0;
    const sampleDuration = duration > 60 ? Math.min(120, duration * 0.5) : Math.min(duration, 10);

    const hwaccel = buildDetectionHwaccelArgs(payload.gpuVendor, payload.sourcePixFmt);
    const args = [
      ...hwaccel.pre,
      '-ss', String(startOffset),
      '-i', filePath,
      '-t', String(sampleDuration),
      // Same missing -map bug as crop detection had — without this,
      // brightness analysis always read whichever video stream ffmpeg
      // defaults to, not the selected track. For a file with a
      // pre-existing HDR encode alongside the SDR original, this could
      // silently analyze the WRONG track's brightness entirely,
      // independent of the bit-depth issue fixed below.
      ...(payload.videoTrackIndex != null ? ['-map', `0:${payload.videoTrackIndex}`] : []),
      // format=yuv420p forces a consistent 8-bit scale before analysis —
      // without this, a 10-bit source (yuv420p10le, common for actual
      // Blu-ray/HDR content) reports YMAX on a 0-1023 scale instead of
      // 0-255, which silently produced impossible values like 733/255.
      // This was a real bug, not a display quirk — confirmed directly by
      // testing an actual 10-bit source and reproducing the same garbage
      // range. Forcing the format here guarantees YMAX is always 0-255,
      // matching what calibrate-npl expects, regardless of source depth.
      '-vf', hwaccel.vfPrefix + 'format=yuv420p,signalstats,metadata=print:file=-',
      '-f', 'null', '-'
    ];
    let proc;
    try {
      proc = spawn(ffmpegPath, args, { windowsHide: true });
      activeProcesses.set('brightness-detect', proc);
    } catch (err) {
      resolve({ error: String(err && err.message || err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", d => stdout += d.toString());
    proc.stderr.on("data", d => stderr += d.toString());
    proc.on("close", (code) => {
      activeProcesses.delete('brightness-detect');
      // Same fix as crop detection above — a genuine process failure
      // (e.g. GPU hwaccel init failing for this source) was being masked
      // as this generic message, identical to what a source with a
      // sample that's genuinely too short produces. Surface the real
      // error when the process didn't actually complete successfully.
      if (code !== 0) {
        const errorLines = stderr.split('\n').filter(l => /error|failed|cannot|unable|invalid|device creation/i.test(l));
        const detail = errorLines.length > 0 ? errorLines.slice(0, 2).join(' | ') : stderr.trim().slice(-300);
        resolve({ error: `Brightness analysis process failed (exit code ${code})${detail ? ': ' + detail : ''}` });
        return;
      }
      const matches = [...stdout.matchAll(/lavfi\.signalstats\.YMAX=(\d+)/g)].map(m => parseInt(m[1]));
      if (matches.length === 0) {
        resolve({ error: 'No brightness data collected — sample may have been too short' });
        return;
      }
      matches.sort((a, b) => a - b);
      const p99Index = Math.floor(matches.length * 0.99);
      // Clamped defensively — format=yuv420p above should make this
      // unnecessary, but a hard ceiling here means an impossible reading
      // can never reach the UI again even from an unforeseen edge case.
      const peakLuma = Math.min(255, matches[Math.min(p99Index, matches.length - 1)]);
      const absoluteMax = Math.min(255, matches[matches.length - 1]);
      resolve({
        peakLuma,          // 99th percentile — the calibration target
        absoluteMax,       // true single-frame max, for reference
        totalSamples: matches.length
      });
    });
    proc.on("error", err => resolve({ error: err.message }));
  });
});

// Empirically finds the highest safe npl value for THIS source's actual
// detected peak brightness, using the exact same filter chain the real
// encode will use (not a separate formula that could drift out of sync
// with it). Builds a synthetic gray patch at the detected peak luma,
// pushes it through increasing npl values, and stops at the last one that
// doesn't clip — same "test then trust" approach as everything else in
// this tool, just automated across a small search instead of a human
// checking each value by hand.
ipcMain.handle('calibrate-npl', async (event, payload) => {
  const { ffmpeg, peakLuma, gamma, saturation } = payload;
  const tmpDir = os.tmpdir();
  const patchPath = path.join(tmpDir, `_npl_calibrate_patch_${Date.now()}.png`);

  function runFF(args) {
    return new Promise((resolve) => {
      const proc = spawn(ffmpeg, args, { windowsHide: true });
      let stderr = "";
      proc.stderr.on("data", d => stderr += d.toString());
      proc.on("close", code => resolve({ code, stderr }));
      proc.on("error", err => resolve({ code: -1, stderr: err.message }));
    });
  }

  // Build a test patch using a representative warm-tone color ratio, not
  // flat neutral gray — a flat gray patch tested optimistic (safe to 200)
  // compared to the established colored-midtone reference point (clips at
  // 190), because the saturation boost pushes channels asymmetrically on
  // real (non-neutral) content. This ratio matches that reference point
  // (180,150,130 normalized) scaled to the detected peak luma, so
  // calibration reflects what actually clips first, not a best case.
  const scale = peakLuma / 180;
  const r = Math.min(255, Math.round(180 * scale));
  const g = Math.min(255, Math.round(150 * scale));
  const b = Math.min(255, Math.round(130 * scale));
  const hexColor = [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  await runFF(['-y', '-f', 'lavfi', '-i', `color=c=0x${hexColor}:s=64x64:d=1`,
    '-frames:v', '1', patchPath]);

  const candidates = [150, 160, 170, 180, 190, 200, 210, 220, 230, 240, 250];
  let safeNpl = 150;

  for (const npl of candidates) {
    const testOut = path.join(tmpDir, `_npl_test_${npl}_${Date.now()}.png`);
    const decodedOut = path.join(tmpDir, `_npl_decoded_${npl}_${Date.now()}.png`);
    const encResult = await runFF(['-y', '-i', patchPath, '-vf',
      `eq=gamma=${gamma}:saturation=${saturation},zscale=transferin=bt709:primariesin=bt709:matrixin=bt709:transfer=smpte2084:primaries=bt2020:matrix=bt2020nc:npl=${npl}:range=tv,format=yuv420p10le`,
      '-update', '1', '-frames:v', '1', testOut]);
    if (encResult.code !== 0) break;
    const decResult = await runFF(['-y', '-i', testOut, '-vf',
      'zscale=transferin=smpte2084:primariesin=bt2020:matrixin=bt2020nc:transfer=bt709:primaries=bt709:matrix=bt709:range=tv,format=yuv420p',
      '-update', '1', '-frames:v', '1', decodedOut]);
    if (decResult.code !== 0) break;

    // Check for clipping by sampling raw pixel data — a gray patch below
    // the clip point should have all three channels under 255.
    const rawResult = await new Promise((resolve) => {
      const proc = spawn(ffmpeg, ['-i', decodedOut, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true });
      const chunks = [];
      proc.stdout.on('data', d => chunks.push(d));
      proc.on('close', () => resolve(Buffer.concat(chunks)));
    });
    const hasClip = rawResult.length > 0 && Array.from(rawResult.slice(0, 30)).some(v => v >= 255);

    for (const f of [testOut, decodedOut]) fs.unlink(f, () => {});

    if (hasClip) break;
    safeNpl = npl;
  }

  fs.unlink(patchPath, () => {});
  return { safeNpl };
});


// on to the next item rather than stopping everything.
const activeProcesses = new Map();

// Cleans up intermediate temp files from multi-stage jobs (the integrated
// downmix/upmix engine produces temp Stereo FLAC and temp 7.1 Vorbis files
// between stages) — best-effort, failures here shouldn't break the job.
// Extracts chapters from the source file, and if a framerate-conversion
// ratio is given, rescales every chapter timestamp by it. This exists
// because -fps conversion in this tool is a genuine speed change, not
// just a relabel (23.976->24 plays ~0.1% faster) — confirmed directly by
// building a real chapter'd file, converting speed, and observing the
// original chapter points landing at the wrong times. Verified this fix
// end-to-end the same way: extract, rescale, re-mux, and confirm the
// output file's actual chapter timestamps land where they should.
ipcMain.handle('extract-and-scale-chapters', async (event, payload) => {
  const { ffmpeg, filePath, ratio, tmpDir, jobId } = payload;
  const chaptersPath = path.join(tmpDir, `_tmp_chapters_${jobId}.txt`);
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(ffmpeg, ['-y', '-i', filePath, '-f', 'ffmetadata', chaptersPath], { windowsHide: true });
    } catch (err) {
      resolve({ hasChapters: false, error: String(err && err.message || err) });
      return;
    }
    let stderr = '';
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', code => {
      if (code !== 0) { resolve({ hasChapters: false, error: stderr }); return; }
      try {
        let content = fs.readFileSync(chaptersPath, 'utf8');
        if (!content.includes('[CHAPTER]')) {
          fs.unlink(chaptersPath, () => {});
          resolve({ hasChapters: false });
          return;
        }
        if (ratio && Math.abs(ratio - 1) > 0.00001) {
          content = content.replace(/^(START|END)=(\d+)$/gm, (match, key, val) => {
            const newVal = Math.round(parseInt(val, 10) / ratio);
            return `${key}=${newVal}`;
          });
          fs.writeFileSync(chaptersPath, content, 'utf8');
        }
        resolve({ hasChapters: true, chaptersPath });
      } catch (err) {
        resolve({ hasChapters: false, error: String(err.message) });
      }
    });
    proc.on('error', err => resolve({ hasChapters: false, error: String(err.message) }));
  });
});

ipcMain.handle('delete-temp-file', async (event, payload) => {
  return new Promise((resolve) => {
    fs.unlink(payload.path, (err) => {
      resolve({ deleted: !err, error: err ? err.message : null });
    });
  });
});

// Pipes ffmpeg's video output DIRECTLY into an external encoder's stdin,
// with ZERO intermediate disk file — this replaces an earlier design that
// wrote an uncompressed Y4M temp file, which was a real, serious bug:
// raw 10-bit 4:2:0 video at ~1920x1080/24fps runs about 136MB PER SECOND,
// meaning a feature-length film needed several hundred GB of temp disk
// space and reliably ran the machine out of room partway through. This is
// also the pattern these tools' own documentation recommends as the
// normal way to use them (ffmpeg | NVEncC/QSVEncC/VCEEncC), not something
// invented here — should have been built this way from the start.
ipcMain.handle('run-piped-encode', async (event, payload) => {
  return new Promise((resolve) => {
    const { ffmpeg, ffmpegArgs, tool, toolArgs, totalDuration, jobId } = payload;
    const { args: routedFfmpegArgs, tempPaths: ffmpegTemp } = routeArgsThroughTempFiles(ffmpegArgs);
    const { args: routedToolArgs, tempPaths: toolTemp } = routeArgsThroughTempFiles(toolArgs);
    const cleanupAll = () => { for (const p of [...ffmpegTemp, ...toolTemp]) fs.unlink(p, () => {}); };

    let ffmpegProc, toolProc;
    try {
      ffmpegProc = spawn(ffmpeg, routedFfmpegArgs, { windowsHide: true });
      toolProc = spawn(tool, routedToolArgs, { windowsHide: true });
    } catch (err) {
      cleanupAll();
      resolve({ code: -1, stdout: "", stderr: String(err && err.message || err) });
      return;
    }

    if (jobId) activeProcesses.set(jobId, toolProc); // stop button kills the encoder; ffmpeg ends naturally when its stdout pipe closes

    ffmpegProc.stdout.pipe(toolProc.stdin);
    // Confirmed via direct testing: killing the downstream tool process
    // (what the Stop button does) causes ffmpeg to try writing to a
    // closed pipe, throwing an unhandled EPIPE that crashes the entire
    // process if not caught here — not a theoretical concern, reproduced
    // directly. Both ends need an error handler; the destination
    // (toolProc.stdin) is where Node actually raises it.
    toolProc.stdin.on('error', () => {}); // EPIPE when the tool exits early — expected on Stop, not a real failure
    ffmpegProc.stdout.on('error', () => {});

    let ffmpegStderr = "";
    let toolStderr = "";
    ffmpegProc.stderr.on("data", d => ffmpegStderr += d.toString());

    // External tools' own progress format varies by tool and isn't
    // something testable from this environment — best-effort parse of
    // common patterns (frame=/time=-style), falling back to elapsed-time
    // display only if nothing matches, rather than pretending precision
    // that hasn't been verified. Confirmed via direct user report that the
    // raw parse can occasionally pick up an unrelated number (these tools
    // rewrite their progress line in place with carriage returns, and
    // stderr arrives in arbitrary chunk boundaries, not necessarily
    // aligned to one complete update) — rather than chase the exact cause
    // blind, guard against it structurally: never let the displayed value
    // move backward, regardless of what the raw parse occasionally matches.
    const startTime = Date.now();
    let lastReportedPercent = 0;
    toolProc.stderr.on("data", d => {
      const text = d.toString();
      toolStderr += text;
      const percentMatch = text.match(/(\d+(?:\.\d+)?)\s*%/);
      const elapsedSec = (Date.now() - startTime) / 1000;
      let percent = lastReportedPercent;
      if (percentMatch) {
        const parsed = parseFloat(percentMatch[1]);
        if (parsed >= lastReportedPercent) percent = parsed; // ignore anything that would move backward
      }
      lastReportedPercent = percent;
      event.sender.send('ffmpeg-progress', {
        percent, currentSec: elapsedSec, totalDuration, speed: 0,
        etaSec: null, done: false, imprecise: !percentMatch
      });
    });

    let ffmpegDone = false, toolDone = false, ffmpegCode = null, toolCode = null;
    function maybeResolve(){
      if (!ffmpegDone || !toolDone) return;
      if (jobId) activeProcesses.delete(jobId);
      cleanupAll();
      const failed = toolCode !== 0;
      resolve({
        code: toolCode,
        stdout: "",
        stderr: failed ? `[external tool]\n${toolStderr}\n[ffmpeg]\n${ffmpegStderr}` : toolStderr,
        killed: toolCode === null
      });
    }
    ffmpegProc.on("close", code => {
      ffmpegDone = true; ffmpegCode = code;
      // Confirmed via a real full-length run that this must NOT kill the
      // tool — ffmpeg closing its stdout is the NORMAL end-of-stream
      // signal once it's done writing, and the tool legitimately needs
      // time afterward to finish encoding its last buffered frames and
      // write its own output. An earlier version force-killed the tool
      // here, which meant every successful run got its encoder killed
      // moments before it would have finished on its own — surfaced as a
      // false "failure" on a run whose logs showed zero actual errors,
      // just a truncated ending right where the kill happened. The tool
      // is left to close on its own; only the reverse direction (tool
      // closing forces ffmpeg to stop) is still needed, since ffmpeg has
      // nothing left to usefully do once its only consumer is gone.
      maybeResolve();
    });
    toolProc.on("close", code => {
      toolDone = true; toolCode = code;
      if (!ffmpegDone) { try { ffmpegProc.kill('SIGKILL'); } catch(e){} }
      maybeResolve();
    });
    ffmpegProc.on("error", err => { ffmpegDone = true; ffmpegStderr += '\n[ffmpeg spawn error] ' + err.message; maybeResolve(); });
    toolProc.on("error", err => { toolDone = true; toolCode = -1; toolStderr += '\n[tool spawn error] ' + err.message; if (!ffmpegDone) { try { ffmpegProc.kill('SIGKILL'); } catch(e){} } maybeResolve(); });
  });
});


ipcMain.handle('run-ffmpeg-with-progress', async (event, payload) => {
  return new Promise((resolve) => {
    const ffmpeg = payload.ffmpeg;
    const totalDuration = payload.totalDuration || 0;
    const jobId = payload.jobId || null;
    const { args, tempPaths } = routeArgsThroughTempFiles(payload.args);

    const progressArgs = ['-progress', 'pipe:1', ...args];

    let proc;
    try {
      proc = spawn(ffmpeg, progressArgs, { windowsHide: true });
    } catch (err) {
      for (const p of tempPaths) fs.unlink(p, () => {});
      resolve({ code: -1, stdout: "", stderr: String(err && err.message || err) });
      return;
    }

    if (jobId) activeProcesses.set(jobId, proc);

    let stdoutBuf = "";
    let stderr = "";
    let lastSentPercent = -1;

    proc.stdout.on("data", d => {
      stdoutBuf += d.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop(); // keep any incomplete trailing line for next chunk
      let currentUpdate = {};
      for (const line of lines) {
        const [key, value] = line.split('=');
        if (!key) continue;
        currentUpdate[key.trim()] = (value || '').trim();
        if (key.trim() === 'progress') {
          // End of one progress block — compute and emit.
          const isDone = currentUpdate.progress === 'end';
          if (isDone) {
            event.sender.send('ffmpeg-progress', {
              percent: 100, currentSec: totalDuration, totalDuration, speed: 0, etaSec: 0, done: true
            });
          } else if (totalDuration > 0 && currentUpdate.out_time_ms && currentUpdate.out_time_ms !== 'N/A') {
            const currentSec = Math.max(0, parseInt(currentUpdate.out_time_ms) / 1000000);
            const percent = Math.max(0, Math.min(100, (currentSec / totalDuration) * 100));
            const speed = parseFloat((currentUpdate.speed || '0x').replace('x', '')) || 0;
            const etaSec = speed > 0 ? (totalDuration - currentSec) / speed : null;
            const roundedPercent = Math.round(percent * 10) / 10;
            if (!Number.isNaN(roundedPercent) && roundedPercent !== lastSentPercent) {
              lastSentPercent = roundedPercent;
              event.sender.send('ffmpeg-progress', {
                percent: roundedPercent,
                currentSec, totalDuration, speed, etaSec,
                done: false
              });
            }
          }
          currentUpdate = {};
        }
      }
    });
    proc.stderr.on("data", d => stderr += d.toString());

    proc.on("close", code => {
      if (jobId) activeProcesses.delete(jobId);
      for (const p of tempPaths) fs.unlink(p, () => {});
      // Windows TerminateProcess (what proc.kill() maps to) typically
      // results in a null exit code rather than a normal 0/nonzero one —
      // used by the renderer to distinguish "killed on purpose" from
      // "actually failed" when deciding what to do next in the queue.
      resolve({ code, stdout: "", stderr, killed: code === null });
    });
    proc.on("error", err => {
      if (jobId) activeProcesses.delete(jobId);
      for (const p of tempPaths) fs.unlink(p, () => {});
      resolve({ code: -1, stdout: "", stderr: String(err.message) });
    });
  });
});

// Kills a specific running ffmpeg job by the same jobId the renderer passed
// to run-ffmpeg-with-progress. Used for the queue's "Stop Current" button —
// stops only the active job, letting the queue advance to the next one
// rather than halting everything.
ipcMain.handle('kill-ffmpeg-job', async (event, payload) => {
  const jobId = payload.jobId;
  const proc = activeProcesses.get(jobId);
  if (!proc) return { killed: false, reason: 'No matching active process (already finished?)' };
  try {
    proc.kill(); // Node maps this to TerminateProcess on Windows — reliably stops ffmpeg.exe
    activeProcesses.delete(jobId);
    return { killed: true };
  } catch (err) {
    return { killed: false, reason: err.message };
  }
});

// Windows' spawn() has a real, fairly low effective command-line length
// limit — ENAMETOOLONG shows up well before any file NAME is actually too
// long, because the whole argument list has to fit in one command line.
// Two things in this app can produce arguments long enough to trip it:
//   1. -filter_complex — some directions (Stereo->7.1 upmix especially)
//      generate long filter graphs (~1-2K characters).
//   2. -metadata:s:a:0 METADATA_BLOCK_PICTURE=<base64> — cover art embedding
//      for Opus/Vorbis. This is the bigger risk by far: a typical album
//      art JPEG becomes a base64 string in the hundreds of KB to low-MB
//      range as a single argument — over 1000x longer than the filter
//      graph case above.
// Both get routed through temp files instead of the command line. Verified
// byte-for-byte identical output vs the direct-argument method for both.
function routeArgsThroughTempFiles(rawArgs) {
  const args = rawArgs.slice();
  const tempPaths = [];

  // -filter_complex -> -filter_complex_script <tempfile>
  const fcIndex = args.indexOf('-filter_complex');
  if (fcIndex !== -1 && args[fcIndex + 1] !== undefined) {
    const filterContent = args[fcIndex + 1];
    const tempFilterPath = path.join(
      os.tmpdir(),
      `ffmpeg-filter-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
    );
    fs.writeFileSync(tempFilterPath, filterContent, 'utf8');
    args[fcIndex] = '-filter_complex_script';
    args[fcIndex + 1] = tempFilterPath;
    tempPaths.push(tempFilterPath);
  }

  // -metadata:s:a:0 KEY=VALUE -> extra ffmetadata input + precise stream mapping.
  // Scans all -metadata* flags (not just :s:a:0) so this stays correct if
  // the stream index or track selector ever changes.
  const extraInputs = [];  // { flagIndexToRemove, valueIndexToRemove, inputArgs, mapMetadataArgs }
  for (let i = 0; i < args.length; i++) {
    if (typeof args[i] === 'string' && args[i].startsWith('-metadata') && args[i + 1] !== undefined) {
      const value = args[i + 1];
      // Only bother routing this through a file if it's actually long enough
      // to matter — no reason to add complexity for short tags like artist/title.
      if (value.length > 4000) {
        const streamSpec = args[i].includes(':') ? args[i].slice('-metadata'.length) : ''; // e.g. ':s:a:0'
        const tempMetaPath = path.join(
          os.tmpdir(),
          `ffmpeg-meta-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
        );
        fs.writeFileSync(tempMetaPath, `;FFMETADATA1\n[STREAM]\n${value}\n`, 'utf8');
        tempPaths.push(tempMetaPath);

        extraInputs.push({
          removeFrom: i,
          removeCount: 2,
          insertInputArgs: ['-i', tempMetaPath],
          // streamSpec is like ':s:a:0' — reuse it so this stays correct
          // even if the target stream index isn't always a:0.
          mapMetadataFlag: `-map_metadata${streamSpec}`
        });
      }
    }
  }

  // Apply removals back-to-front so earlier indices don't shift.
  let finalArgs = args.slice();
  for (const ei of extraInputs.reverse()) {
    finalArgs.splice(ei.removeFrom, ei.removeCount);
  }

  // Insert each temp metadata file as an additional -i input right after
  // the primary -i, and add the matching -map_metadata:s:a:N pointing at
  // its [STREAM] section (input index N = its position among all inputs).
  if (extraInputs.length > 0) {
    const firstIIndex = finalArgs.indexOf('-i');
    let insertAt = firstIIndex !== -1 ? firstIIndex + 2 : 0;
    let nextInputIndex = 1; // input 0 is the primary source
    for (const ei of extraInputs.reverse()) {
      finalArgs.splice(insertAt, 0, ...ei.insertInputArgs);
      insertAt += ei.insertInputArgs.length;
      finalArgs.splice(insertAt, 0, ei.mapMetadataFlag, `${nextInputIndex}:s:0`);
      insertAt += 2;
      nextInputIndex++;
    }
  }

  return { args: finalArgs, tempPaths };
}

// Detects the actual channel count of a loaded file via ffprobe, so the
// UI can warn/auto-correct when the selected Input Channel Layout doesn't
// match reality. This directly prevents a real, confirmed failure mode:
// selecting "7.1" for a genuinely 5.1 file silently routes through the
// wrong downmix coefficients (the 7.1-specific back-channel coefficient,
// correct only when real side+back surrounds both exist, gets misapplied
// to a 5.1 file's only surround pair) — channel routing itself isn't
// broken, but content gets measurably under-preserved as a result.
ipcMain.handle('get-channel-count', async (event, payload) => {
  return new Promise((resolve) => {
    const ffmpegPath = payload.ffmpeg;
    const filePath = payload.filePath;
    // ffprobe ships alongside ffmpeg in the same bin directory in every
    // standard distribution (gyan.dev, BtbN, etc.) — derive its path rather
    // than requiring a second manually-configured field.
    const ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, (m, ext) => 'ffprobe' + (ext || ''));

    const args = ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'csv=p=0', filePath];
    let proc;
    try {
      proc = spawn(ffprobePath, args, { windowsHide: true });
    } catch (err) {
      resolve({ error: String(err && err.message || err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", d => stdout += d.toString());
    proc.stderr.on("data", d => stderr += d.toString());
    proc.on("close", code => {
      if (code !== 0) {
        resolve({ error: stderr || `ffprobe exited with code ${code}` });
        return;
      }
      const channels = parseInt(stdout.trim(), 10);
      resolve({ channels: Number.isNaN(channels) ? null : channels });
    });
    proc.on("error", err => {
      resolve({ error: err.message });
    });
  });
});

ipcMain.handle('run-ffmpeg', async (event, payload) => {
  return new Promise((resolve) => {

    const ffmpeg = payload.ffmpeg;
    const { args, tempPaths } = routeArgsThroughTempFiles(payload.args);

    console.log("\n===== FFMPEG START =====\n");
    console.log(ffmpeg);
    console.log(args);
    console.log("\n========================\n");

    const cleanup = () => {
      for (const p of tempPaths) fs.unlink(p, () => {});
    };

    let proc;
    try {
      proc = spawn(ffmpeg, args, { windowsHide: true });
    } catch (err) {
      cleanup();
      resolve({ code: -1, stdout: "", stderr: String(err && err.message || err) });
      return;
    }

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", d => stdout += d.toString());
    proc.stderr.on("data", d => stderr += d.toString());

    proc.on("close", code => {
      cleanup();
      resolve({ code, stdout, stderr });
    });

    proc.on("error", err => {
      cleanup();
      resolve({ code: -1, stdout, stderr: stderr + '\n' + err.message });
    });
  });
});

app.whenReady().then(() => {
  // Each window only opens if its file actually exists in this folder — so
  // this works whether you keep index.html + video.html together (both
  // windows open) or run video.html on its own in a separate folder
  // (only that window opens, no blank/broken window for the missing one).
  const hasIndex = fs.existsSync(path.join(__dirname, 'index.html'));
  const hasVideo = fs.existsSync(path.join(__dirname, 'video.html'));
  if (hasIndex) createWindow();
  if (hasVideo) createVideoWindow();
  if (!hasIndex && !hasVideo) {
    console.error('Neither index.html nor video.html found in this folder — nothing to open.');
  }
});
