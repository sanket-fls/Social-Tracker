// Makes the other cut of a video right in the browser: 9:16 from 16:9, or 16:9 from 9:16.
// It plays the video once into a canvas, so it takes about as long as the video runs, and writes a standard MP4
// (H.264 video, AAC audio, index at the front) with the browser's own encoders. No server, no Claude run.
import { Muxer, ArrayBufferTarget } from './vendor/mp4-muxer-5.2.2.mjs';

const SIZE = { '9x16': [1080, 1920], '16x9': [1920, 1080] };
const AUDIO_BPS = 128000;

async function firstSupported(codecs, cfg) {
  for (const codec of codecs) {
    try { if ((await VideoEncoder.isConfigSupported({ ...cfg, codec })).supported) return codec; } catch (e) {}
  }
  return null;
}

// style: 'blur' fits the whole video over a blurred copy of itself, 'black' fits it on black, 'crop' fills the frame.
function painter(ctx, v, W, H, style) {
  const small = new OffscreenCanvas(Math.round(W / 12), Math.round(H / 12));
  const sctx = small.getContext('2d');
  sctx.filter = 'blur(3px)';
  ctx.imageSmoothingQuality = 'high';
  const put = (c, scale, cw, ch) => { const w = v.videoWidth * scale, h = v.videoHeight * scale; c.drawImage(v, (cw - w) / 2, (ch - h) / 2, w, h); };
  return () => {
    const vw = v.videoWidth, vh = v.videoHeight;
    if (style === 'crop') return put(ctx, Math.max(W / vw, H / vh), W, H);
    if (style === 'blur') {
      put(sctx, Math.max(small.width / vw, small.height / vh) * 1.15, small.width, small.height);
      ctx.drawImage(small, 0, 0, W, H);
      ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(0, 0, W, H);
    } else { ctx.fillStyle = '#0e0e0e'; ctx.fillRect(0, 0, W, H); }
    put(ctx, Math.min(W / vw, H / vh), W, H);
  };
}

export async function reframe(src, target, style, onProgress = () => {}, signal) {
  const [W, H] = SIZE[target];
  if (typeof VideoEncoder === 'undefined') throw new Error('This browser can’t make videos. Use Google Chrome on a Mac or Windows computer.');
  const buf = await (await fetch(src)).arrayBuffer();

  // The sound is copied over as it is. A video without sound simply gets none.
  let audio = null;
  try { audio = await new OfflineAudioContext(2, 1, 48000).decodeAudioData(buf.slice(0)); } catch (e) {}
  if (audio && audio.length < 2) audio = null;

  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto';
  v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:.01;pointer-events:none';
  v.src = URL.createObjectURL(new Blob([buf], { type: 'video/mp4' }));
  document.body.appendChild(v);
  let ve = null;
  try {
    await new Promise((ok, no) => { v.onloadedmetadata = ok; v.onerror = () => no(new Error('This video can’t be opened in the browser.')); });
    const dur = v.duration;
    if (!isFinite(dur) || dur <= 0) throw new Error('This video has no length the browser can read.');
    // Sized to stay under the upload limit, with a little room to spare.
    const MAX_BYTES = Math.max(20, (window.flBigMb || window.flMaxMb || 50) - 5) * 1048576;
    const bps = Math.min(8e6, Math.floor(MAX_BYTES * 8 / dur) - (audio ? AUDIO_BPS : 0));
    if (bps < 1.2e6) throw new Error('This video is too long to convert here (the limit is about ' + Math.floor(MAX_BYTES * 8 / 1.33e6 / 60) + ' minutes). Export the other format from your video editor instead.');

    const codec = await firstSupported(['avc1.640028', 'avc1.4d0028', 'avc1.42e028'], { width: W, height: H, bitrate: bps, framerate: 30 });
    if (!codec) throw new Error('This browser can’t make MP4 video. Use Google Chrome on a Mac or Windows computer.');
    let aCfg = null;
    if (audio) {
      aCfg = { codec: 'mp4a.40.2', sampleRate: audio.sampleRate, numberOfChannels: Math.min(2, audio.numberOfChannels), bitrate: AUDIO_BPS };
      if (!(await AudioEncoder.isConfigSupported(aCfg)).supported) throw new Error('This browser can’t make the sound track. Use Google Chrome on a Mac or Windows computer.');
    }

    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: 'avc', width: W, height: H },
      audio: aCfg ? { codec: 'aac', numberOfChannels: aCfg.numberOfChannels, sampleRate: aCfg.sampleRate } : undefined,
      fastStart: 'in-memory',
      firstTimestampBehavior: 'cross-track-offset',
    });
    let failed = null;

    if (aCfg) {
      const ae = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: e => { failed = e; } });
      ae.configure(aCfg);
      const ch = aCfg.numberOfChannels, rate = audio.sampleRate;
      for (let i = 0; i < audio.length; i += rate) {
        const n = Math.min(rate, audio.length - i), data = new Float32Array(n * ch);
        for (let c = 0; c < ch; c++) data.set(audio.getChannelData(c).subarray(i, i + n), c * n);
        const ad = new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: n, numberOfChannels: ch, timestamp: Math.round(i / rate * 1e6), data });
        ae.encode(ad); ad.close();
      }
      await ae.flush(); ae.close();
    }

    ve = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: e => { failed = e; } });
    ve.configure({ codec, width: W, height: H, bitrate: bps, framerate: 30, latencyMode: 'quality', avc: { format: 'avc' } });
    const canvas = new OffscreenCanvas(W, H), ctx = canvas.getContext('2d'), draw = painter(ctx, v, W, H, style);
    let last = -1, lastKey = -1e9, poster = null;

    await new Promise((ok, no) => {
      const onFrame = (now, meta) => {
        if (failed) return no(failed);
        if (signal && signal.aborted) return no(new DOMException('Stopped', 'AbortError'));
        const t = Math.round(meta.mediaTime * 1e6);
        if (t > last && ve.encodeQueueSize < 30) {
          draw();
          const key = t - lastKey >= 2e6;
          const frame = new VideoFrame(canvas, { timestamp: t });
          ve.encode(frame, { keyFrame: key }); frame.close();
          if (key) lastKey = t;
          last = t;
          if (!poster && meta.mediaTime >= Math.min(1, dur / 2)) poster = canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
        }
        onProgress(Math.min(1, meta.mediaTime / dur), dur);
        if (!v.ended) v.requestVideoFrameCallback(onFrame);
      };
      v.requestVideoFrameCallback(onFrame);
      v.onended = () => ok();
      v.onerror = () => no(new Error('The video stopped playing.'));
      if (signal) signal.addEventListener('abort', () => no(new DOMException('Stopped', 'AbortError')), { once: true });
      v.play().catch(no);
    });

    await ve.flush();
    if (failed) throw failed;
    muxer.finalize();
    onProgress(1, dur);
    return {
      blob: new Blob([muxer.target.buffer], { type: 'video/mp4' }),
      poster: await (poster || canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })),
      width: W, height: H, duration: dur,
    };
  } finally {
    if (ve && ve.state !== 'closed') ve.close();
    v.pause(); URL.revokeObjectURL(v.src); v.remove();
  }
}
