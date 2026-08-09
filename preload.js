const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getPath: (file) => file.path,
  runFFmpeg: (payload) => ipcRenderer.invoke('run-ffmpeg', payload),
  getChannelCount: (payload) => ipcRenderer.invoke('get-channel-count', payload),
  getDuration: (payload) => ipcRenderer.invoke('get-duration', payload),
  getVideoInfo: (payload) => ipcRenderer.invoke('get-video-info', payload),
  getHdrMetadata: (payload) => ipcRenderer.invoke('get-hdr-metadata', payload),
  detectCrop: (payload) => ipcRenderer.invoke('detect-crop', payload),
  analyzeBrightness: (payload) => ipcRenderer.invoke('analyze-brightness', payload),
  calibrateNpl: (payload) => ipcRenderer.invoke('calibrate-npl', payload),
  runFFmpegWithProgress: (payload) => ipcRenderer.invoke('run-ffmpeg-with-progress', payload),
  runPipedEncode: (payload) => ipcRenderer.invoke('run-piped-encode', payload),
  runTriplePipedEncode: (payload) => ipcRenderer.invoke('run-triple-piped-encode', payload),
  killFFmpegJob: (payload) => ipcRenderer.invoke('kill-ffmpeg-job', payload),
  deleteTempFile: (payload) => ipcRenderer.invoke('delete-temp-file', payload),
  writeTextFile: (payload) => ipcRenderer.invoke('write-text-file', payload),
  extractAndScaleChapters: (payload) => ipcRenderer.invoke('extract-and-scale-chapters', payload),
  onFFmpegProgress: (callback) => ipcRenderer.on('ffmpeg-progress', (event, data) => callback(data))
});
