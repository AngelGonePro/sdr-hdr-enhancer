For setup go to https://github.com/AngelGonePro/spatial-audio

NVIDIA Options are enabled by default, if you have an AMD or Intel GPU change encoder and toggle their respective encoding parameters.

WARNING: AMD AND INTEL GPU ACCELERATION HAS NOT BEEN TESTED. IF YOU HAVE AN ISSUE WITH THESE 2 PLEASE OPEN A PULL REQUEST WITH ANY AND ALL LOGS THE APP GIVES YOU THIS INCLUDES THE WEBUI AND CONSOLE!!!!

## Dependencies

| Dependency | Needed for | Default path the app expects |
|---|---|---|
| [Node.js LTS](https://nodejs.org) | Runs the Electron app (`npm install`, `npm start`) | n/a |
| [ffmpeg 8.x full build](https://www.gyan.dev/ffmpeg/builds/) (includes ffprobe) | Everything | `C:\Users\Angel\Documents\ffmpeg-8.0.1-full_build\bin\ffmpeg.exe` |
| [NVEncC 9.x](https://github.com/rigaya/NVEnc/releases) (zip, extract) | Main HDR10 encode | `...\Aviutl_NVEnc_9.29\exe_files\NVEncC\x64\NVEncC64.exe` |
| NVIDIA driver (current) | NVEncC and the denoiser's Vulkan backend | n/a |
| [MKVToolNix](https://mkvtoolnix.download) | Muxing | `C:\Program Files\MKVToolNix\mkvmerge.exe` |
| Python 3.14 | `vspipe` and the denoiser (`vsavd` needs 3.12+) | `C:\Python314\Scripts\vspipe.exe` |
| [VapourSynth](https://github.com/vapoursynth/vapoursynth/releases) (full installer) | Denoise stage | n/a |
| ffms2 plugin (`vsrepo install ffms2`) | Source reader for the denoise stage | n/a |
| `vsavd` (`pip install vsavd`) | Motion-compensated grain removal (av-denoise) | n/a |
| [PgsToSrt](https://github.com/Tentacule/PgsToSrt/releases) | PGS subtitle OCR | `...\PgsToStr-1.4.8\PgsToSrt.exe` |
| [dovi_tool](https://github.com/quietvoid/dovi_tool/releases), [hdr10plus_tool](https://github.com/quietvoid/hdr10plus_tool/releases), mkvdovi (hdr-analyze), [MediaInfo CLI](https://mediaarea.net/en/MediaInfo/Download) | Optional: Dolby Vision / HDR10+ | `C:\dovi_tool\`, `C:\hdr10plus_tool\`, `C:\hdr-analyze\`, `C:\MediaInfo_CLI\` |

### Install (PowerShell)

```powershell
winget install OpenJS.NodeJS.LTS
winget install Gyan.FFmpeg
winget install MoritzBunkus.MKVToolNix
winget install Python.Python.3.14

# restart PowerShell, then:
C:\Python314\python.exe -m pip install vapoursynth vsavd
C:\Python314\Scripts\vsrepo.exe install ffms2   # run as Administrator

npm install
npm start
```

## Images:

![alt text](https://raw.githubusercontent.com/AngelGonePro/sdr-hdr-enhancer/refs/heads/main/media/Screenshot%202026-08-04%20152725.png)

## Gif (Yes I know its bad quality, but file size limit is a thing):
![demo](https://github.com/AngelGonePro/sdr-hdr-enhancer/releases/download/media/gifmakingbitch-ezgif.com-optimize.gif)
