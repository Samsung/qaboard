import { useState, useCallback } from 'react';

// Remembered in this browser, for all the video viewers
export const usePreference = (name, initial) => {
  const key = `qaboard:video-viewer:${name}`;
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? initial : JSON.parse(stored);
    } catch {
      return initial;
    }
  });
  const update = useCallback(next => {
    setValue(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // private browsing...
    }
  }, [key]);
  return [value, update];
};

export const fileUrl = (output, path) =>
  `${output.output_dir_url}/${path.split('/').map(encodeURIComponent).join('/')}`;

// 75.5 => 1:15.500
export const formatTime = seconds => {
  if (!Number.isFinite(seconds)) return '-:--';
  const ms = Math.round(Math.max(0, seconds) * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const rest = `${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
};

export const formatFps = fps => `${Number.isInteger(fps) ? fps : fps.toFixed(3).replace(/0+$/, '')} fps`;

// https://developer.mozilla.org/en-US/docs/Web/API/MediaError/code
export const mediaErrorMessage = error => {
  if (!error) return null;
  const reasons = {
    1: 'Loading the video was aborted.',
    2: 'A network error stopped the download.',
    3: 'The video is corrupted, or uses features your browser can\'t decode.',
    4: 'The file is missing, or your browser doesn\'t support its format or codec.',
  };
  return reasons[error.code] ?? error.message ?? 'The video can\'t play.';
};

// The video's current frame, as a PNG
export const frameBlob = source => new Promise((resolve, reject) => {
  try {
    let canvas = source;
    if (source instanceof HTMLVideoElement) {
      canvas = document.createElement('canvas');
      canvas.width = source.videoWidth;
      canvas.height = source.videoHeight;
      canvas.getContext('2d').drawImage(source, 0, 0);
    }
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('No frame to copy')), 'image/png');
  } catch (error) {
    reject(error);
  }
});

export const copyFrame = source => {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined')
    return Promise.reject(new Error('Your browser can\'t copy images here (it needs https)'));
  // a promise keeps the click's "user activation" in Safari
  return navigator.clipboard.write([new ClipboardItem({ 'image/png': frameBlob(source) })]);
};

export const saveFrame = async (source, filename) => {
  const blob = await frameBlob(source);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
