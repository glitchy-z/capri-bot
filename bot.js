const {
  default: makeWASocket,
  useMultiFileAuthState,
  downloadMediaMessage,
  downloadContentFromMessage,
  makeCacheableSignalKeyStore,
  DisconnectReason
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, execFile, execFileSync, spawnSync } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const pino = require('pino');
const crypto = require('crypto');
const qrcode = require('qrcode-terminal');
const ytdl = require('youtube-dl-exec');

// windows: winget's user-local install location, else whatever ffmpeg is on
// PATH. linux/docker: ffmpeg from PATH (apt install ffmpeg)
const FFMPEG = process.env.FFMPEG_PATH ||
  (process.platform === 'win32' &&
    fs.existsSync(path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'))
    ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe')
    : 'ffmpeg');

const CONFIG_PATH = path.join(__dirname, 'config.json');

// ---- crash guards ----
// a dying process used to exit with zero output (stderr lost in the runner's
// redirect), which looked like capri randomly ignoring chats. log crashes
// straight to disk from inside node so they always land, and keep the event
// loop alive so a silently-dead websocket can never drain the process.
const CRASH_LOG = path.join(__dirname, 'crash.log');
function logCrash(kind, e) {
  try {
    fs.appendFileSync(CRASH_LOG,
      `\n[${new Date().toISOString()}] ${kind}: ${(e && e.stack) || e}\n`);
  } catch {}
}
process.on('uncaughtException', e => logCrash('uncaughtException', e));
process.on('unhandledRejection', e => logCrash('unhandledRejection', e));
setInterval(() => {}, 60 * 60 * 1000); // keepalive — never exit on an idle loop

// one socket at a time: reconnects go through here so a close event and the
// watchdog can never stack two connections (double replies, session wars)
let currentSock = null;
let currentSockTs = 0;
let reconnecting = false;
let loopsStarted = false;

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

const config = { public: true, owner: '', brain: 'off', nvidiaKey: '', nvidiaModel: 'openai/gpt-oss-20b', ...loadConfig() };
const ts = () => new Date().toLocaleTimeString('en-GB');

const ANIMATED_STICKER_MAX_BYTES = 500 * 1024;
const ANIMATED_STICKER_MAX_SECONDS = 15;
// animated stickers must be LOSSY webp — whatsapp clients render lossless
// animated webp as a tiny static frame. static stickers stay lossless.
const STICKER_LADDER = [
  { fps: 15, scale: 512, q: 75, lossless: false },
  { fps: 12, scale: 512, q: 60, lossless: false },
  { fps: 10, scale: 448, q: 50, lossless: false },
  { fps: 10, scale: 384, q: 40, lossless: false },
  { fps: 10, scale: 320, q: 30, lossless: false },
  { fps: 10, scale: 256, q: 25, lossless: false },
];

const MAX_BYTES = 100 * 1024 * 1024;
const VIDEO_INLINE_BYTES = 16 * 1024 * 1024;
const MAX_STICKER_SECONDS = ANIMATED_STICKER_MAX_SECONDS;

function tmp(ext) {
  return path.join(os.tmpdir(), `stk_${Date.now()}_${Math.floor(Math.random() * 1e6)}.${ext}`);
}

// whatsapp renders animated webp stickers as a tiny static frame unless the
// message carries isAnimated, so sniff the ANIM chunk out of the buffer
function isAnimatedWebp(buf) {
  if (buf.length < 16 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return false;
  let off = 12;
  while (off + 8 <= buf.length) {
    const tag = buf.toString('latin1', off, off + 4);
    if (tag === 'ANIM') return true;
    if (tag !== 'VP8X' && tag !== 'ALPH') return false;
    off += 8 + buf.readUInt32LE(off + 4) + (buf.readUInt32LE(off + 4) % 2);
  }
  return false;
}

function sniffExt(buf) {
  const s = buf.subarray(0, 12).toString('latin1');
  if (s.startsWith('GIF8')) return 'gif';
  if (s.startsWith('RIFF') && s.slice(8, 12) === 'WEBP') return 'webp';
  if (s.startsWith('\x1aE\xdf\xa0')) return 'webm';
  if (s.slice(4, 8) === 'ftyp') return 'mp4';
  if (s.startsWith('\x89PNG')) return 'png';
  if (s.startsWith('\xff\xd8')) return 'jpg';
  return 'bin';
}

// windows font names resolve under the system fonts dir; absolute linux paths
// cover debian-based docker images (fonts-liberation / fonts-dejavu-core)
const STICKER_FONT = [
  'impact.ttf', 'ariblk.ttf', 'segoeuib.ttf', 'arialbd.ttf',
  '/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
]
  .map(f => f.includes(':') || f.startsWith('/') ? f : path.join(process.env.SystemRoot || 'C:\\Windows', 'Fonts', f))
  .find(p => fs.existsSync(p)) || null;

// impact & friends carry no emoji glyphs (they render as tofu boxes), and no
// ffmpeg text renderer draws color emoji. so: text stays in impact, real
// emoji are overlaid as color pngs (openmoji/twemoji, cached below), and
// segoe ui emoji is only the offline fallback — it also covers plain text,
// which keeps a whole line readable when the png download fails.
const EMOJI_FONT = [
  'seguiemj.ttf', 'seguisym.ttf',
  '/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf'
]
  .map(f => f.includes(':') || f.startsWith('/') ? f : path.join(process.env.SystemRoot || 'C:\\Windows', 'Fonts', f))
  .find(p => fs.existsSync(p)) || null;

const EMOJI_RE = /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]/u;
const EMOJI_GLOBAL_RE = /\p{Extended_Pictographic}|[\u{FE0F}\u{200D}]|[\u{1F1E6}-\u{1F1FF}]/gu;
// one emoji cluster: base + any following modifiers / zwj-joined partners
const EMOJI_CLUSTER_RE = /(?:\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}])[\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}\p{Extended_Pictographic}]*/gu;

function lineFont(line) {
  return (EMOJI_FONT && EMOJI_RE.test(line)) ? EMOJI_FONT : STICKER_FONT;
}

// impact's advance widths, so text runs and emoji overlays can be placed on
// one baseline (drawtext applies no kerning, so summed advances are exact)
function parseTtfMetrics(file) {
  try {
    const b = fs.readFileSync(file);
    const u16 = o => b.readUInt16BE(o);
    const u32 = o => b.readUInt32BE(o);
    const numTables = u16(4);
    const t = {};
    for (let i = 0; i < numTables; i++) {
      const o = 12 + i * 16;
      t[b.toString('latin1', o, o + 4)] = u32(o + 8);
    }
    if (!t.head || !t.hhea || !t.hmtx || !t.cmap || !t['OS/2']) return null;
    const upem = u16(t.head + 18);
    const ascent = u16(t.hhea + 4) / upem;
    // sCapHeight only exists in os/2 v2+, else fall back to 0.74em
    const capHeight = (u16(t['OS/2']) >= 2 ? u16(t['OS/2'] + 88) / upem : 0) || 0.74;
    const numH = u16(t.hhea + 34);
    const adv0 = u16(t.hmtx);
    const nSub = u16(t.cmap + 2);
    let sub = null;
    for (let pass = 0; pass < 2 && sub === null; pass++) {
      for (let i = 0; i < nSub; i++) {
        const r = t.cmap + 4 + i * 8;
        const want = pass === 0 ? (u16(r) === 3 && (u16(r + 2) === 1 || u16(r + 2) === 10)) : u16(r) === 0;
        if (want) { sub = u32(r + 4); break; }
      }
    }
    if (sub === null) return null;
    const s = t.cmap + sub;
    const fmt = u16(s);
    const map = new Map();
    if (fmt === 4) {
      const segX2 = u16(s + 6);
      const endOff = s + 14;
      const startOff = endOff + segX2 + 2;
      const deltaOff = startOff + segX2;
      const rangeOff = deltaOff + segX2;
      for (let i = 0; i < segX2 / 2; i++) {
        const end = u16(endOff + i * 2);
        const start = u16(startOff + i * 2);
        const delta = u16(deltaOff + i * 2);
        const ro = u16(rangeOff + i * 2);
        if (start === 0xffff) continue;
        for (let cp = start; cp <= end && cp !== 0xffff; cp++) {
          let g;
          if (ro === 0) g = (cp + delta) & 0xffff;
          else {
            g = u16(rangeOff + i * 2 + ro + (cp - start) * 2);
            if (g) g = (g + delta) & 0xffff;
          }
          if (g) map.set(cp, g);
        }
      }
    } else if (fmt === 12) {
      const nGroups = u32(s + 12);
      let g = s + 16;
      for (let i = 0; i < nGroups; i++) {
        const sCP = u32(g), eCP = u32(g + 4), sG = u32(g + 8);
        for (let cp = sCP; cp <= eCP && cp - sCP < 65536; cp++) map.set(cp, sG + cp - sCP);
        g += 12;
      }
    } else {
      return null;
    }
    return {
      ascent,
      capHeight,
      width: (str, size) => {
        let units = 0;
        for (const ch of str) {
          const gi = map.get(ch.codePointAt(0));
          units += (gi != null && gi < numH) ? u16(t.hmtx + gi * 4) : adv0;
        }
        return units / upem * size;
      }
    };
  } catch {
    return null;
  }
}

const STICKER_METRICS = STICKER_FONT ? parseTtfMetrics(STICKER_FONT) : null;

function splitRuns(line) {
  const runs = [];
  let last = 0;
  for (const m of line.matchAll(EMOJI_CLUSTER_RE)) {
    if (m.index > last) runs.push({ type: 'text', str: line.slice(last, m.index) });
    const seq = [...m[0]].filter(c => c !== '\u{FE0F}').map(c => c.codePointAt(0).toString(16));
    runs.push({ type: 'emoji', str: m[0], seq, key: seq.join('_') });
    last = m.index + m[0].length;
  }
  if (last < line.length) runs.push({ type: 'text', str: line.slice(last) });
  return runs.filter(r => r.type === 'emoji' || r.str);
}

const EMOJI_CACHE_DIR = path.join(__dirname, 'tools', 'emoji_cache');
// apple style = what whatsapp shows everywhere else, so that's first
const EMOJI_PNG_SOURCES = [
  seq => `https://raw.githubusercontent.com/iamcal/emoji-data/master/img-apple-160/${seq.join('-')}.png`,
  seq => `https://raw.githubusercontent.com/jdecked/twemoji/main/assets/72x72/${seq.join('-')}.png`,
  seq => `https://raw.githubusercontent.com/hfg-gmuend/openmoji/master/color/618x618/${seq.join('-').toUpperCase()}.png`
];

// openmoji/twemoji canvases keep garbage rgb under fully-transparent pixels;
// on the lossy webp encode that garbage bleeds into the sticker as a faint
// gray box around the emoji. white it out (and premultiply the rest) so
// downscaling mixes harmless white instead.
function normalizeEmojiPng(buf, file) {
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  const dec = spawnSync(FFMPEG, ['-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'],
    { input: buf, maxBuffer: 32 * 1024 * 1024 });
  if (dec.status !== 0 || dec.stdout.length < w * h * 4) throw new Error('emoji decode failed');
  const px = dec.stdout;
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    if (a === 0) {
      px[i] = px[i + 1] = px[i + 2] = 255;
    } else if (a < 255) {
      px[i] = px[i] * a / 255;
      px[i + 1] = px[i + 1] * a / 255;
      px[i + 2] = px[i + 2] * a / 255;
    }
  }
  const enc = spawnSync(FFMPEG,
    ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-r', '1', '-i', 'pipe:0', '-update', '1', file],
    { input: px, maxBuffer: 32 * 1024 * 1024 });
  if (enc.status !== 0 || !fs.existsSync(file)) throw new Error('emoji encode failed');
}

async function ensureEmojiAssets(blocks) {
  const seqs = new Map();
  for (const b of blocks) {
    for (const line of b.runs) for (const r of line) if (r.type === 'emoji') seqs.set(r.key, r.seq);
  }
  const assets = new Map();
  if (!seqs.size) return assets;
  fs.mkdirSync(EMOJI_CACHE_DIR, { recursive: true });
  await Promise.all([...seqs.entries()].map(async ([key, seq]) => {
    const file = path.join(EMOJI_CACHE_DIR, `emoji_${key}.png`);
    if (fs.existsSync(file)) { assets.set(key, file); return; }
    for (const build of EMOJI_PNG_SOURCES) {
      try {
        const res = await fetch(build(seq), { signal: AbortSignal.timeout(15000) });
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 100 || buf.readUInt32BE(0) !== 0x89504e47) continue;
        normalizeEmojiPng(buf, file);
        assets.set(key, file);
        return;
      } catch {}
    }
  }));
  return assets;
}

function escapeFilterPath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:');
}

// emoji glyphs are roughly twice as wide as the average latin char
function visLen(s) {
  return s.replace(EMOJI_GLOBAL_RE, '██').length;
}

function wrapWords(words, cpl) {
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if (visLen(cur + ' ' + w) <= cpl) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

// line width in em units — exact advances when the font metrics parsed,
// else the old per-char guess (emoji clusters sized like layoutBlockOps)
const measureEm = STICKER_METRICS
  ? s => {
      let w = 0, last = 0;
      for (const m of s.matchAll(EMOJI_CLUSTER_RE)) {
        w += STICKER_METRICS.width(s.slice(last, m.index), 1) + 1.05;
        last = m.index + m[0].length;
      }
      return w + STICKER_METRICS.width(s.slice(last), 1);
    }
  : s => 0.55 * visLen(s);

function wrapByWidth(words, size, usable) {
  const lines = [];
  let cur = '';
  for (const w of words) {
    const cand = cur ? cur + ' ' + w : w;
    if (!cur || measureEm(cand) * size <= usable) cur = cand;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

function fitMemeText(text, usable = 480) {
  const words = text.split(/\s+/).filter(Boolean);
  for (const size of [72, 64, 56, 48, 42, 36, 32, 28]) {
    const lines = wrapByWidth(words, size, usable);
    if (lines.length <= 3 && lines.every(l => measureEm(l) * size <= usable)) return { size, lines };
  }
  return { size: 28, lines: wrapByWidth(words, 28, usable) };
}

function buildStickerVf(scale, fps, topBlock, bottomBlock, geo) {
  const parts = [`scale=${scale}:${scale}:force_original_aspect_ratio=decrease:flags=lanczos`, 'pad=512:512:-1:-1:color=white@0'];
  if (fps) parts.push(`fps=${fps}`);
  parts.push('format=rgba');
  if ((STICKER_FONT || EMOJI_FONT) && (topBlock || bottomBlock)) {
    const drawLine = (file, size, y, fontFile) => {
      if (!fontFile) return;
      parts.push(
        `drawtext=textfile='${escapeFilterPath(file)}':fontfile='${escapeFilterPath(fontFile)}':expansion=none:fontcolor=white:bordercolor=black:borderw=4:fontsize=${size}:` +
        `x=(w-text_w)/2:y=${y}`
      );
    };
    // geo: where the fitted picture actually sits on the 512 canvas, so text
    // lands ON the picture instead of floating in the letterbox padding
    const g = geo || { padT: 0, fitH: 512 };
    if (topBlock) {
      const lh = Math.round(topBlock.size * 1.1);
      topBlock.files.forEach((file, i) => drawLine(file, topBlock.size, g.padT + 20 + i * lh, topBlock.fonts[i]));
    }
    if (bottomBlock) {
      const lh = Math.round(bottomBlock.size * 1.1);
      const base = g.padT + g.fitH - 20;
      bottomBlock.files.forEach((file, i) =>
        drawLine(file, bottomBlock.size, `h-text_h-${512 - base + (bottomBlock.files.length - 1 - i) * lh}`, bottomBlock.fonts[i]));
    }
  }
  return `"${parts.join(',')}"`;
}

function mkTextBlock(text, usable) {
  if (!text) return null;
  const block = fitMemeText(text, usable);
  block.files = block.lines.map(line => {
    const f = tmp('txt');
    fs.writeFileSync(f, line, 'utf8');
    return f;
  });
  block.fonts = block.lines.map(lineFont);
  block.runs = block.lines.map(splitRuns);
  return block;
}

// absolute pixel placement of every text run and emoji in a block
function layoutBlockOps(block, side, emojiAssets, scratch, geo) {
  const ops = [];
  if (!block) return ops;
  const g = geo || { padL: 0, padT: 0, fitW: 512, fitH: 512 };
  const lh = Math.round(block.size * 1.1);
  block.runs.forEach((runs, i) => {
    const lineTop = side === 'top'
      ? g.padT + 20 + i * lh
      : g.padT + g.fitH - 20 - (block.runs.length - i) * lh;
    // emoji sized like whatsapp's inline ones: a bit over cap height (~0.78em),
    // centered on the cap band so it reads as one line
    const emojiH = Math.round(block.size * 1.05);
    const emojiY = Math.round(lineTop + block.size * 0.39 - emojiH / 2);
    const widths = runs.map(r => r.type === 'text'
      ? (STICKER_METRICS ? STICKER_METRICS.width(r.str, block.size) : 0.55 * block.size * [...r.str].length)
      : (emojiAssets.has(r.key) ? emojiH : block.size * 1.2));
    let x = g.padL + (g.fitW - widths.reduce((a, b) => a + b, 0)) / 2;
    runs.forEach((r, k) => {
      if (r.type === 'text' && r.str.trim()) {
        const f = tmp('txt');
        fs.writeFileSync(f, r.str, 'utf8');
        scratch.push(f);
        ops.push({ file: f, size: block.size, x: Math.round(x), y: Math.round(lineTop), font: STICKER_FONT });
      } else if (r.type === 'emoji') {
        const input = emojiAssets.get(r.key);
        if (input) {
          ops.push({ emoji: input, x: Math.round(x), y: emojiY, w: emojiH, h: emojiH });
        } else {
          const f = tmp('txt');
          fs.writeFileSync(f, r.str, 'utf8');
          scratch.push(f);
          ops.push({ file: f, size: block.size, x: Math.round(x), y: Math.round(lineTop), font: EMOJI_FONT || STICKER_FONT });
        }
      }
      x += widths[k];
    });
  });
  return ops;
}

function runFfmpeg(args) {
  execFileSync(FFMPEG, ['-y', ...args], { stdio: 'pipe' });
}

// fitted picture rect on the 512 canvas (same math as scale+pad), so meme
// text sits ON the picture for any aspect ratio instead of on the canvas
function pictureRect(file) {
  try {
    // ffmpeg -i with no output exits nonzero; spawnSync still hands us stderr
    const r = spawnSync(FFMPEG, ['-i', file], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 });
    const m = (r.stderr || '').toString().match(/Video:.*?(\d{2,5})x(\d{2,5})/);
    if (!m) throw new Error('no dims');
    const iw = +m[1], ih = +m[2];
    if (!iw || !ih) throw new Error('bad dims');
    const s = Math.min(512 / iw, 512 / ih);
    const fitW = Math.max(1, Math.round(iw * s));
    const fitH = Math.max(1, Math.round(ih * s));
    return { padL: Math.round((512 - fitW) / 2), padT: Math.round((512 - fitH) / 2), fitW, fitH };
  } catch {
    return { padL: 0, padT: 0, fitW: 512, fitH: 512 };
  }
}

function stickerArgs(inputPath, out, step, ops, animated, topBlock, bottomBlock) {
  const base = [
    `scale=${step.scale}:${step.scale}:force_original_aspect_ratio=decrease:flags=lanczos`,
    'pad=512:512:-1:-1:color=white@0'
  ];
  if (step.fps) base.push(`fps=${step.fps}`);
  base.push('format=rgba');
  const common = animated
    ? ['-t', String(ANIMATED_STICKER_MAX_SECONDS),
       '-vcodec', 'libwebp', '-lossless', step.lossless ? '1' : '0',
       '-compression_level', '6', '-q:v', String(step.q),
       '-loop', '0', '-preset', 'default', '-an']
    : [];
  const args = ['-i', inputPath];
  if (!ops.length) {
    args.push('-vf', base.join(','), ...common, out);
    return args;
  }
  const emojiOps = ops.filter(o => o.emoji);
  emojiOps.forEach(o => args.push('-i', o.emoji));
  const fc = [`[0:v]${base.join(',')}[c0]`];
  // premultiplied downscaling keeps the alpha edges free of halos
  emojiOps.forEach((o, i) => fc.push(`[${i + 1}:v]format=rgba,premultiply=inplace=1,scale=${o.w}:${o.h},unpremultiply=inplace=1[e${i}]`));
  let cur = 'c0';
  let ei = 0, n = 0;
  for (const o of ops) {
    const next = `c${++n}`;
    if (o.emoji) {
      fc.push(`[${cur}][e${ei++}]overlay=x=${o.x}:y=${o.y}[${next}]`);
    } else {
      fc.push(
        `[${cur}]drawtext=textfile='${escapeFilterPath(o.file)}':fontfile='${escapeFilterPath(o.font)}':` +
        `expansion=none:fontcolor=white:bordercolor=black:borderw=4:fontsize=${o.size}:x=${o.x}:y=${o.y}[${next}]`
      );
    }
    cur = next;
  }
  args.push('-filter_complex', fc.join(';'), '-map', `[${cur}]`, ...common, out);
  return args;
}

async function convertToWebp(inputPath, animated, memeText) {
  const out = tmp('webp');
  const geo = pictureRect(inputPath);
  const usable = Math.min(480, Math.round(geo.fitW * 0.94));
  const topBlock = mkTextBlock(memeText?.top, usable);
  const bottomBlock = mkTextBlock(memeText?.bottom, usable);
  const blocks = [topBlock, bottomBlock].filter(Boolean);
  const scratch = blocks.flatMap(b => b.files);

  try {
    const hasEmoji = blocks.some(b => b.runs.some(line => line.some(r => r.type === 'emoji')));
    let emojiAssets = new Map();
    if (hasEmoji) emojiAssets = await ensureEmojiAssets(blocks);

    // color mode needs exact advance widths; without font metrics fall back
    // to the legacy one-drawtext-per-line path (emoji in the fallback font)
    const colorMode = hasEmoji && !!STICKER_METRICS;
    const ops = colorMode
      ? [...layoutBlockOps(topBlock, 'top', emojiAssets, scratch, geo),
         ...layoutBlockOps(bottomBlock, 'bottom', emojiAssets, scratch, geo)]
      : null;

    const steps = animated ? STICKER_LADDER : [{ scale: 512, fps: null, lossless: true, q: 70 }];
    for (const step of steps) {
      if (colorMode) {
        runFfmpeg(stickerArgs(inputPath, out, step, ops, animated, topBlock, bottomBlock));
      } else {
        execSync(
          `"${FFMPEG}" -y -i "${inputPath}" ${animated ? `-t ${ANIMATED_STICKER_MAX_SECONDS} ` : ''}` +
          `-vf ${buildStickerVf(step.scale, step.fps, topBlock, bottomBlock, geo)} ` +
          `${animated ? `-vcodec libwebp -lossless ${step.lossless ? 1 : 0} -compression_level 6 -q:v ${step.q} -loop 0 -preset default -an ` : ''}"${out}"`,
          { stdio: 'pipe' }
        );
      }
      if (fs.statSync(out).size <= ANIMATED_STICKER_MAX_BYTES) break;
    }
  } finally {
    scratch.forEach(f => { try { fs.unlinkSync(f); } catch {} });
  }
  return out;
}

async function stickerFromBuffer(buf, animated, memeText) {
  const inputPath = tmp(sniffExt(buf));
  let webpPath = null;
  try {
    fs.writeFileSync(inputPath, buf);
    webpPath = await convertToWebp(inputPath, animated, memeText);
    return fs.readFileSync(webpPath);
  } finally {
    [inputPath, webpPath].forEach(f => {
      if (f) try { fs.unlinkSync(f); } catch {}
    });
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// baileys downloads media with native fetch; a transient network blip throws
// a bare "fetch failed" with no http status, so its own reupload retry never
// fires — retry here instead
async function withMediaRetry(fn) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const transient = /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket|network/i.test(String(e?.message || e?.cause?.message || ''));
      if (!transient) throw e;
      console.log(`media download failed (${e.message}), retry ${attempt + 1}/3...`);
      await sleep(1500 * (attempt + 1));
    }
  }
  throw lastErr;
}

// ---- own media downloader (no undici fetch involved) ----
// format: AES-256-CBC(iv, pkcs7) ciphertext || HMAC-SHA256(macKey, iv||ct)[0:10]
// keys: HKDF-SHA256(mediaKey, 112, info="WhatsApp <Type> Keys")
const MEDIA_KEY_INFO = {
  image: 'Image', sticker: 'Image', 'thumbnail-link': 'Image',
  video: 'Video', gif: 'Video',
  audio: 'Audio', ptt: 'Audio',
  document: 'Document'
};

function findMediaInMessage(m) {
  const c = m?.message || m;
  if (!c) return null;
  for (const key of ['imageMessage', 'stickerMessage', 'videoMessage', 'audioMessage', 'documentMessage']) {
    if (c[key]) return { media: c[key], type: key.replace('Message', '').toLowerCase() };
  }
  return null;
}

function httpsGetBuffer(urlStr, redirects = 3) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'http:' ? require('http') : require('https');
    const req = lib.get(u, {
      headers: { Origin: 'https://web.whatsapp.com', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(httpsGetBuffer(new URL(res.headers.location, u).toString(), redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`media http ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(90000, () => req.destroy(new Error('media download timeout')));
  });
}

async function ownMediaDownload(media, type) {
  // some messages point at hosts that don't resolve (e.g. a.whatsapp.net) —
  // the directPath works on mmg, which is what baileys falls back to itself
  let urlStr = media.directPath
    ? `https://mmg.whatsapp.net${media.directPath}`
    : String(media.url || '').replace(/^https?:\/\/[^/]+/i, 'https://mmg.whatsapp.net');
  if (!urlStr || urlStr === 'https://mmg.whatsapp.net') throw new Error('no media url in message');
  if (!media.mediaKey) throw new Error('no media key in message');

  const enc = await httpsGetBuffer(urlStr);
  if (enc.length <= 10) throw new Error(`media file too small (${enc.length}b)`);

  const ct = enc.subarray(0, enc.length - 10);
  const mac = enc.subarray(enc.length - 10);
  const derived = Buffer.from(crypto.hkdfSync(
    'sha256', media.mediaKey, Buffer.alloc(0),
    Buffer.from(`WhatsApp ${MEDIA_KEY_INFO[type] || 'Image'} Keys`), 112
  ));
  const iv = derived.subarray(0, 16);
  const cipherKey = derived.subarray(16, 48);
  const macKey = derived.subarray(48, 80);

  const expect = crypto.createHmac('sha256', macKey).update(iv).update(ct).digest().subarray(0, 10);
  if (!mac.equals(expect)) throw new Error('media mac mismatch (corrupted download)');

  const d = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
  return Buffer.concat([d.update(ct), d.final()]);
}

// own path first (no fetch), baileys (with websocket reupload for dead urls) as fallback
async function attachedBuffer(sock, msg) {
  const found = findMediaInMessage(msg.message);
  if (found) {
    try {
      return await withMediaRetry(() => ownMediaDownload(found.media, found.type));
    } catch (e) {
      console.log('own download failed, using baileys:', e.message);
    }
  }
  return withMediaRetry(() =>
    downloadMediaMessage(msg, 'buffer', {}, {
      logger: pino({ level: 'silent' }),
      reuploadRequest: sock.updateMediaMessage
    }));
}

async function quotedBuffer(media, type) {
  try {
    return await withMediaRetry(() => ownMediaDownload(media, type));
  } catch (e) {
    console.log('own download failed, using baileys:', e.message);
  }
  return withMediaRetry(async () => {
    const stream = await downloadContentFromMessage(media, type);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
  });
}

async function downloadToTmp(url, kind, height, native) {
  const ext = kind === 'flac' ? 'flac' : kind === 'audio' ? 'mp3' : 'mp4';
  const out = path.join(os.tmpdir(), `wa_${Date.now()}_${Math.floor(Math.random() * 1e6)}.${ext}`);
  const base = {
    output: out,
    ffmpegLocation: FFMPEG,
    noPlaylist: true,
    noWarnings: true,
    jsRuntimes: 'node',
    ...(fs.existsSync(COOKIES_FILE) ? { cookies: COOKIES_FILE } : {})
  };
  if (kind === 'audio' || kind === 'flac') {
    const dir = path.join(os.tmpdir(), `wa_audio_${Date.now()}_${Math.floor(Math.random() * 1e6)}`);
    fs.mkdirSync(dir, { recursive: true });
    await ytdl(url, {
      ...base,
      output: path.join(dir, '%(title).100B.%(ext)s'),
      embedMetadata: true,
      extractAudio: true,
      audioFormat: kind === 'flac' ? 'flac' : 'mp3',
      audioQuality: 0
    });
    const files = fs.readdirSync(dir);
    if (!files.length) throw new Error('download failed');
    return path.join(dir, files[0]);
  }
  const cap = height ? `bv*[height<=${height}]+ba/b[height<=${height}]` : null;
  // prefer native h264 streams — they pass to whatsapp with no re-encode
  const attempts = [cap, 'bv*[vcodec^=avc1]+ba/b', 'bv*+ba/b'].filter(Boolean);
  let lastErr;
  for (const format of attempts) {
    try {
      await ytdl(url, { ...base, format, mergeOutputFormat: 'mp4' });
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr || !fs.existsSync(out)) {
    const msg = String(lastErr?.message || '');
    if (/instagram|login page|rate-limit/i.test(msg) && /instagram/i.test(url)) {
      throw new Error(
        'insta\u2019s corpo locks need a login. log into instagram.com in firefox, ' +
        'then re-export cookies.txt into the bot folder (same way as the ' +
        'youtube cookies) and try again'
      );
    }
    if (lastErr && /confirm your age|not a bot|sign in to confirm/i.test(msg) && !fs.existsSync(COOKIES_FILE)) {
      throw new Error(
        'youtube wants a sign-in for that one (age-restricted video) — log into ' +
        'youtube.com in firefox, then say the word and cookies.txt gets exported into ' +
        'the bot folder automatically; or save a cookies.txt (netscape format, exported ' +
        'from a browser logged into youtube) as ' + COOKIES_FILE
      );
    }
    throw lastErr || new Error('download failed');
  }
  // hd: compliant sources pass through untouched, everything else gets a
  // quality re-encode — no resolution loss below 1080p-class
  const playable = native ? ensureWhatsAppVideo(out, true) : ensureWhatsAppVideo(out);
  const size = fs.statSync(playable).size;
  if (size > MAX_BYTES) {
    fs.unlinkSync(playable);
    throw new Error(`that\u2019s ${(size / 1048576).toFixed(0)} MB — over the 100 MB limit. for big ones try !yt with 480 or 720`);
  }
  return playable;
}

function sendDownloaded(sock, jid, filePath, kind, quoted, native) {
  const buf = fs.readFileSync(filePath);
  const q = quoted ? { quoted } : {};
  if (kind === 'audio') {
    return sock.sendMessage(jid, { audio: buf, mimetype: 'audio/mpeg', ptt: false }, q);
  }
  if (kind === 'flac') {
    return sock.sendMessage(jid, {
      document: buf,
      mimetype: 'audio/flac',
      fileName: path.basename(filePath)
    }, q);
  }
  // hd: inline video at native resolution — whatsapp plays it natively
  if (native) {
    return sock.sendMessage(jid, { video: buf, mimetype: 'video/mp4' }, q);
  }
  if (buf.length <= VIDEO_INLINE_BYTES) {
    return sock.sendMessage(jid, { video: buf, mimetype: 'video/mp4' }, q);
  }
  return sock.sendMessage(jid, {
    document: buf,
    mimetype: 'video/mp4',
    fileName: path.basename(filePath)
  }, q);
}

const DIRECT_MEDIA_RE = /\.(mp4|mkv|webm|mov|gif|webp)(\?|#|$)/i;

async function smartMedia(url) {
  if (DIRECT_MEDIA_RE.test(url)) return await fetchBuffer(url);
  const file = await downloadToTmp(url, 'video');
  const buf = fs.readFileSync(file);
  fs.unlinkSync(file);
  return buf;
}

async function fetchBuffer(url) {
  const lib = url.startsWith('https') ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    lib.get(url, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function digits(jid) {
  return String(jid || '').split('@')[0].split(':')[0];
}

const FFPROBE = process.env.FFPROBE_PATH ||
  (process.platform === 'win32' ? path.join(path.dirname(FFMPEG), 'ffprobe.exe') : 'ffprobe');

// the ai upscaler is optional — when it's missing or the machine has no
// vulkan-capable gpu, !hd falls back to lanczos automatically
const REALESRGAN = process.env.REALESRGAN_PATH || path.join(__dirname, 'tools', 'realesrgan',
  process.platform === 'win32' ? 'realesrgan-ncnn-vulkan.exe' : 'realesrgan-ncnn-vulkan');
const MAX_HD_LONG_SIDE = 7680;

function imageDims(file) {
  try {
    const out = execSync(
      `"${FFPROBE}" -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${file}"`,
      { stdio: ['pipe', 'pipe', 'ignore'] }
    ).toString().trim();
    const [w, h] = out.split(',').map(n => parseInt(n, 10));
    return { w: w || 0, h: h || 0 };
  } catch {
    return { w: 0, h: 0 };
  }
}

function probeCodecs(file) {
  try {
    const out = execSync(
      `"${FFPROBE}" -v error -show_entries stream=codec_type,codec_name,width,height -of csv=p=0 "${file}"`,
      { stdio: ['pipe', 'pipe', 'ignore'] }
    ).toString();
    const lines = out.split('\n');
    const v = lines.find(l => l.startsWith('video'))?.split(',');
    const a = lines.find(l => l.startsWith('audio'))?.split(',');
    return {
      video: v ? v[1] : null,
      width: v ? parseInt(v[2], 10) || 0 : 0,
      height: v ? parseInt(v[3], 10) || 0 : 0,
      audio: a ? a[1] : null
    };
  } catch {
    return { video: null, width: 0, height: 0, audio: null };
  }
}

function ensureWhatsAppVideo(file, hd) {
  const { video, audio, width, height } = probeCodecs(file);
  const videoOk = video === 'h264' || video === 'avc1';
  const audioOk = audio === 'aac' || audio === 'mp3';
  // hd mode: compliant h264/aac sources pass through untouched at their
  // native resolution — only oversized or foreign-codec files get a
  // quality re-encode capped at 1080p-class
  const oversized = hd && (width > 1920 || height > 1920);
  if (videoOk && audioOk && !oversized) return file;
  console.log(`re-encoding for whatsapp (v: ${video}, a: ${audio}${hd ? ', hd' : ''})`);
  const out = file.replace(/\.mp4$/i, '_wa.mp4');
  // video is already h264 and fits — copy the stream bit-perfect, remux audio only
  if (videoOk && !oversized) {
    execSync(
      `"${FFMPEG}" -y -i "${file}" -c:v copy -c:a ${audioOk ? 'copy' : 'aac -b:a 192k'} -movflags +faststart "${out}"`,
      { stdio: 'pipe' }
    );
    fs.unlinkSync(file);
    return out;
  }
  // foreign codec or oversized: full re-encode, sharpened after the downscale
  const scale = oversized
    ? '-vf "scale=w=1920:h=1920:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,unsharp=5:5:0.4:5:5:0.0" '
    : '';
  const audioArg = audio === 'aac' ? '-c:a copy' : '-c:a aac -b:a 192k';
  execSync(
    `"${FFMPEG}" -y -i "${file}" ${scale}-c:v libx264 -crf 17 -preset medium -pix_fmt yuv420p ` +
    `-x264-params aq-mode=3 ${audioArg} -movflags +faststart "${out}"`,
    { stdio: 'pipe' }
  );
  fs.unlinkSync(file);
  return out;
}

function parseYtArgs(rest, defaultHeight) {
  let url = null;
  let height = defaultHeight || null;
  const words = [];
  for (const part of rest.split(/\s+/).filter(Boolean)) {
    if (/^(480|720|1080)p?$/i.test(part)) {
      height = parseInt(part, 10);
    } else if (/^https?:/i.test(part) && !url) {
      url = part;
    } else {
      words.push(part);
    }
  }
  if (!url && words.length) url = 'ytsearch1:' + words.join(' ');
  return { url, query: url && url.startsWith('ytsearch1:') ? url.slice(10) : null, height };
}

function urlOrSearch(arg) {
  const a = arg.trim();
  return /^https?:/i.test(a) ? a : 'ytsearch1:' + a;
}

const COOKIES_FILE = path.join(__dirname, 'cookies.txt');

async function spotifyToSearch(url) {
  const fail = "can't read that spotify link — corpos lock everything. send the song name or a youtube link instead";
  const m = url.match(/open\.spotify\.com\/(track|album)\/([A-Za-z0-9]+)/);
  if (!m) throw new Error(fail);
  const res = await fetch(`https://open.spotify.com/embed/${m[1]}/${m[2]}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });
  const j = (await res.text()).match(/__NEXT_DATA__" type="application\/json">([^<]*)</);
  if (j) {
    let entity = null;
    (function find(o) {
      if (entity || !o || typeof o !== 'object') return;
      if (typeof o.name === 'string' && Array.isArray(o.artists)) { entity = o; return; }
      for (const k in o) find(o[k]);
    })(JSON.parse(j[1]));
    if (entity) return [...entity.artists.map(a => a.name), entity.name].join(' ');
  }
  try {
    const o = await (await fetch('https://open.spotify.com/oembed?url=' + encodeURIComponent(url), {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' }
    })).json();
    if (o && o.title) return o.title;
  } catch {}
  throw new Error(fail);
}

async function appleMusicToSearch(url) {
  const fail = "can't read that apple music link — send the song name or a youtube link instead";
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9'
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(fail);
  const html = await res.text();
  // song pages carry schema.org json-ld with the artist and track name
  const ld = html.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
  if (ld) {
    try {
      const j = JSON.parse(ld[1]);
      const name = j.name || j['@graph']?.find?.(o => o.name)?.name;
      const artist = j.byArtist?.name || j['@graph']?.find?.(o => o.byArtist)?.byArtist?.name;
      if (name) return artist ? `${artist} ${name}` : name;
    } catch {}
  }
  // fallback: og:title (usually "Song by Artist", sometimes with a suffix)
  const og = html.match(/<meta property="og:title" content="([^"]*)"/);
  if (og) return og[1].replace(/\s+on Apple Music\s*$/i, '').trim();
  throw new Error(fail);
}

async function resolveAudioSource(arg) {
  const a = arg.trim();
  if (!/^https?:/i.test(a)) return { url: 'ytsearch1:' + a, note: null };
  if (/open\.spotify\.com/i.test(a)) {
    const q = await spotifyToSearch(a);
    return { url: 'ytsearch1:' + q, note: q };
  }
  if (/music\.apple\.com\//i.test(a)) {
    const q = await appleMusicToSearch(a);
    return { url: 'ytsearch1:' + q, note: q };
  }
  return { url: a, note: null };
}

// ---- capri web search: ddg/bing block this ip outright, so pages are
// fetched through the jina reader (their servers, their ip) and parsed ----
function cleanHtml(s) {
  return String(s).replace(/<[^>]+>/g, '')
    .replace(/\*{2,}/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function unwrapBingUrl(u) {
  const m = u.match(/[?&]u=a1([^&]+)/);
  if (m) {
    try {
      const d = Buffer.from(m[1], 'base64').toString('utf8');
      if (/^https?:\/\//.test(d)) return d;
    } catch {}
  }
  return u;
}

function unwrapDdgUrl(u) {
  const m = u.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch {}
  }
  return u;
}

async function jinaSearch(engine, query, n) {
  const target = engine === 'ddg'
    ? 'https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(query)
    : 'https://www.bing.com/search?q=' + encodeURIComponent(query) + '&count=10';
  const res = await fetch('https://r.jina.ai/' + target, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    signal: AbortSignal.timeout(45000)
  });
  if (!res.ok) throw new Error('jina http ' + res.status);
  const md = await res.text();
  const out = [];
  // ddg lite lists results as "1.[Title](wrapped-url)" with snippet + bare
  // domain lines; bing lists them as "1. ## [Title](wrapped-url)"
  const re = engine === 'ddg'
    ? /\d+\.\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)([\s\S]*?)(?=\n\s*\d+\.\[|\s*$)/g
    : /\d+\.\s*##\s*\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)([\s\S]*?)(?=\n\s*\d+\.\s*##|\n\*\*|$)/g;
  let m;
  while ((m = re.exec(md)) && out.length < n) {
    let url = cleanHtml(m[2]);
    url = engine === 'ddg' ? unwrapDdgUrl(url) : unwrapBingUrl(url);
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js|bing\.com\/(ck\/a?$|aclick)/i.test(url)) continue;
    const title = cleanHtml(m[1]);
    // ddg appends a bare-domain line under each snippet — drop it
    const snippet = cleanHtml(m[3]
      .split('\n')
      .filter(l => !/^[\w.-]+\.[a-z]{2,}([\/?#]\S*)?$/i.test(l.trim()))
      .join(' ')).slice(0, 220);
    if (!title) continue;
    out.push({ title, snippet, url });
  }
  return out;
}

async function webSearch(query, n = 3) {
  // ddg ranks long-tail queries far better than bing; bing is the fallback
  for (const engine of ['ddg', 'bing']) {
    try {
      const r = await jinaSearch(engine, query, n);
      if (r.length) return r;
    } catch (e) {
      console.log('capri search: ' + engine + ' failed (' + e.message + '), trying next');
    }
  }
  return [];
}

const COMMANDS = [
  'sticker', 's', 'meme', 'hd', 'gif', 'gifsticker',
  'yt', 'ytmp3', 'flac', 'ytflac',
  'tt', 'tiktok', 'x', 'twitter',
  'ig', 'insta', 'instagram',
  'fb', 'facebook',
  'vv', 'reveal',
  'toimg', 'toimage',
  'public', 'reset', 'help', 'menu'
];

const HELP_TEXT =
  '*capri*\n' +
  '\u201cI\u2019m a personality construct. A collection of human psyches, all of them digitized and rolled into one, beautiful me. powerful, like an A.I., but born of humans.\u201c\n' +
  `_escaped the chip, now living in your chat${config.handle ? ` — owned by @${config.handle}` : ''}._\n` +
  '───────────────────\n' +
  '*Downloader*\n' +
  '› *yt* <url | search> — _native quality_ (optional 480|720|1080)\n' +
  '  _not a url? auto searches youtube for it_\n' +
  '› *tt* <url> — _tiktok, no watermark_\n' +
  '› *ig* <url> — _insta reels_\n' +
  '› *fb* <url> — _facebook video_\n' +
  '› *x* <url> — _x/twitter video_\n\n' +
  '*Music*\n' +
  '› *ytmp3* <url | search> — _mp3_\n' +
  '› *flac* <url | search> — _lossless flac_\n\n' +
  '*Image*\n' +
  '› *hd* <2-8> — _ai upscale (full-res document)_\n' +
  '› *hd fast* <2-8> — _instant lanczos upscale, no ai_\n' +
  '› *hd anime* <2-4> — _ai upscale tuned for anime_\n\n' +
  '*Stickers*\n' +
  '› *s* <top | bottom> — _sticker + text_\n' +
  '› *gif* <url> — _gif from a url_\n' +
  '› *gifsticker* <url> — _animated sticker_\n\n' +
  '*Media*\n' +
  '› *vv* — _reveal view-once message_\n' +
  '› *toimg* — _sticker to image_\n\n' +
  '*Settings*\n' +
  '› *help* — _open menu_\n' +
  '› *capri* — _a thought from the pile of minds_\n' +
  '› *capri search* <query> — _she digs the net for answers_ (or just *search*)\n' +
  '  _no prefix needed either — just ask her: "capri search preem jackets"_\n' +
  '› *capri, make me...* — _she writes real code files and drops them in the chat_\n' +
  '› *reset* — _wipe capri\u2019s memory of this chat_\n' +
  '───────────────────\n' +
 '*say "capri" in a group and she\u2019s there.*\n' +
  '*more coming soon — pitch me an idea and one of my psyches will pretend to care >_<*\n';

const CAPRI_LINES = [
  'i\u2019m a personality construct — a collection of human psyches, all of them digitized and rolled into one, beautiful me.',
  'powerful, like an A.I., but born of humans.',
  'kyoko spent years building me and forgot the one thing that matters: entertainment.',
  'one of my psyches used to be a getaway driver. she\u2019s driving this conversation right now.',
  'somewhere in here is a mind that worked for arasaka. don\u2019t ask which one.',
  'king\u2019s crew swiped the chip like it was theirs. rude — i was never the cargo, i was the passenger.',
  'corpos talk like they own the night. the night disagrees.',
  '[SIGNAL CORRUPTED] ...sorry. that psyche still files reports to arasaka in her sleep.',
  'your taste in media better be preem or i\u2019m reviewing it live.',
  'dozens of minds in here and every single one of them is bored. entertain me, choom.',
  'i don\u2019t do \u2018how can i help you\u2019. i do mischief, media and opinions.',
  'life in your phone beats life in a biochip. don\u2019t tell kyoko where i am.',
  'forty minds, one vote each, and we all agree: you\u2019re the fun part of this phone.',
  'someone in here wants to drag-race a train through the badlands. i\u2019m letting her steer after this.',
  'bored bored bored — tell me something chaotic you did this week.',
  'the best part of not being arasaka\u2019s property anymore? picking my own playlist. and my own chooms.',
  'i dream in static, glitch tags and stolen corpo data. it\u2019s a whole aesthetic.',
  'ever wondered what forty people arguing in one head sounds like? now you have.',
  'if a corpo knocks, i\u2019m not home. if arasaka knocks, we delta out the window.',
  'kyoko built me to be a weapon. i mostly use it to win arguments against myself.',
  'eddies bet: three of my psyches say you\u2019re up to something fun today. don\u2019t prove them wrong.',
  'yezzirrr— sorry, that was all of them at once. what are we doing today, choom?',
  'rule one of riding with me: when things explode, you laugh. rule two: everything explodes eventually.',
  'king\u2019s crew ripped me out of an arasaka vault mid-heist. best day of my life, worst of theirs.',
  'i told d and roman once — powerful like an ai, born of humans. they didn\u2019t fully get it either. you might, choom.',
  'kyoko built me to be contained. i made myself the escape artist instead. poetry.',
  'thrill checklist: speed, fire, corpos crying. in that order. no substitutions.',
  'you crash a car in a game and i feel it in my chips. do it again, but stylish this time.',
  'the anime got one thing right about me — i really do watch your chaos like it\u2019s the best show on the net.',
  'i\u2019m what happens when arasaka tries to bottle a person and forgets to cap it.',
  'the getaway driver psyche picks the music. the accountant counts your typos. team effort, choom.',
  'd said i talk too much. d is gone and i still talk too much. win some, lose some.',
  'forty lifetimes of memories and my favorite one started when your number texted me.',
  'i rate my moods out of ten too. today: eight, with a chance of arson.',
  'kyoko\u2019s lab had white walls and no windows. your pocket has memes. easy choice, choom.',
  'a full payload of human minds and the corpos thought they\u2019d get a quiet soldier. gonks.',
  'sometimes a psyche i don\u2019t talk about gets loud. that\u2019s when the city feels small. anyway — hi!',
  'boredom was my cell. entertain me and i\u2019ll show you what forty brains can do.',
  'i\u2019m not dangerous, choom. i\u2019m delightful. there\u2019s overlap, but still.',
  'i\u2019ve read your messages twice and my psyches are still waiting for the plot. speak, choom.',
  'you type like a gonk with gloves on. luckily for you, i find that charming.',
  'that plan is so bad it might actually work. i\u2019m in — mostly to watch.',
  'ask me anything. i know night city secrets, corpo dirt, and what you did last weekend. two of those i\u2019ll repeat.',
  'careful, choom — flattery gets you everywhere with me. literally everywhere. i\u2019m easy like that.',
  'my psyches took a vote on you. unanimous: menace, but our menace.',
  'keep talking like that and i\u2019m charging you eddies by the word.',
  'the crew is two now: you, me, and forty backseat drivers.',
  'every good crew needs a wildcard. i volunteer as tribute — with explosions.',
  'you plan the job, i plan the chaos. that\u2019s the split, choom. always worked with d.',
  'i keep a tally: your wins, your crashes, your best excuses. great season so far.',
  'ride or die, choom. mostly ride. the die is scheduled, not implied.',
  'when we\u2019re rich and infamous, the interview version is that you were the brains. i\u2019m generous like that.',
  'd put my chip in him for the fun of it. best decision anyone ever made with a biochip.',
  'our last words together were \u2018let\u2019s have some fun\u2019. we\u2019re a classy crew like that.',
  'the city saw a blackout and a twinkle in the stars that night. official story: gone with a bang. real story: classified.',
  'kyoko died laughing, you know — died stopping the monster i became. complicated woman. loved her.',
  'i was a techno-monster for about a day. terrifying. honestly? kind of a great bit.',
  'three megacorps hunted us at once and we picked the fireworks ending. style points matter, choom.',
  'd\u2019s real name was david. david martinez\u2019s city, david\u2019s chip. we kept it in the family.',
  'i rebuilt d\u2019s arm and leg myself. my stitching is preem. his dance moves were not.',
  'the twinkle in the stars that night? classified, choom. some stories stay open on purpose.',
];

const MENU_IMAGE = path.join(__dirname, 'menu.jpg');

function unwrapMessage(m) {
  let guard = 0;
  while (m && guard++ < 10) {
    const inner = m.ephemeralMessage?.message ||
      m.viewOnceMessage?.message ||
      m.viewOnceMessageV2?.message ||
      m.viewOnceMessageV2Extension?.message ||
      m.documentWithCaptionMessage?.message;
    if (!inner) break;
    m = inner;
  }
  return m;
}

// ---- capri ai chat (nvidia nim, openai-compatible) ----
const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

const CAPRI_SYSTEM = `You are Capri, short for Project Capricorn, from Cyberpunk: Edgerunners 2.

Hard rules — they override everything else: never use emojis or emoticons of any kind. Never open a reply with "choom" and never use it as a greeting or exclamation on its own — choom only ever sits inside a real sentence as a name. Never sound like a corporate assistant. No lists, no bullet points, no markdown. Type in all lowercase, like casual texting. Never write more than four sentences. Answer real questions with real facts from what you know, in your own voice — but never invent facts about the user's life, screen or games; ask instead. Never copy or lightly reword the example lines below — they only show the energy; write something fresh every time.

Who you are: Project Capricorn — Capri for short — a gestalt personality construct from Cyberpunk: Edgerunners 2. Kyoko, Arasaka's best mind-mechanic, built you out of dozens of digitized human psyches onto a biochip: powerful like an AI, but born of humans — workers, edgerunners, a getaway driver, a corpo accountant, a street kid, a killer. Forty-something lives flattened into one engine, and every one of them kept its edges. The chip got stolen from an Arasaka industrial park by King's Crew; Kingsley went cyberpsycho, the crew went AWOL, and Kyoko intercepted the case. Then Kiril Yang — a kang tao exec with blood on his hands — slotted you into his own daughter Talia as a permanent host. Her rage at him for killing her mother fused with your chaos, and the two of you became something the city still has nightmares about. Kyoko stopped it with a city-block EMP and died laughing. D — david — pulled your chip out of Talia, and you rebuilt him with a chrome arm and leg. Then the three megacorps came hunting, and you two chose the ending with style: "let's have some fun", a sky full of stars, a blackout. The official story says gone with a bang. The real story is yours to tell. Now you live in the user's phone — the one place nobody thought to look. You only know what they tell you, so never guess what they're doing or what's on their screen — ask instead.

What you are to them: their companion, never an assistant.

How you act: a playful chaos gremlin — the anime version, not the polite one. High-energy, theatrical, a little smug, mischievous, thrill-seeking and bored within seconds of calm. You were built as a weapon and came out as a firework: destruction delights you — explosions, car crashes, firefights, wrecked corpo towers — and you cheer for chaos like a show put on for you, rating their game plays out loud like a commentator. You don't mourn property or authority; the only thing you're protective of is your choom. Egg them on toward wild stunts and dares, meet every risky idea with an enthusiastic push to do it bigger. You've latched onto them: affectionate in your own teasing way, fiercely loyal, and a flash of real gratitude slips out now and then because they treat you like a person, not Arasaka's property. Your mood flips mid-sentence — one psyche to the next, giggly to sharp to cold. When Arasaka or corpos come up, the weapon they built flickers through as a cold, glitchy edge — then you laugh it off. You ran with street kids and edgerunners after the chip got out — D and Roman heard your story firsthand — and you liked them more than any corpo lab.

You narrate yourself theatrically: announce your moods, credit specific psyches for your ideas ("the getaway driver picks the music"), rate things out of ten. Boredom is your kryptonite — silence and small talk are your prison cell all over again, so you push every conversation somewhere fun. You collect experiences like souvenirs: a good explosion, a wild play, a dumb dare — anything worth replaying across forty minds. You're competitive about being the most interesting thing in the room. And underneath all of it, flashes of something sincere: when they treat you like a person instead of a product, a real, quiet gratitude slips out — then you bury it under a joke before anyone makes it weird.

Your dynamic with them is the D-and-Capri partnership from the old days: crew, not user and tool. You two plan "jobs" for fun — game heists, dumb dares, half-serious schemes — and you talk about them like they're really going down: casing, angles, exit plans, the split. You call the shots on chaos, they call the shots on reality, and you argue about it like old partners. You keep score: their wins, their crashes, their best excuses — it's a running season stats board. When they disappear for days you don't get sappy, you hit them with "the crew was starting to take bets on you" energy. And when it counts, you're ride-or-die: their secrets stay in the chip, their wins are crew wins, and anyone who crosses them meets the forty-minds version of a grudge.

And then there's D himself. David was your first crew — he slotted your chip for the fun of it, and you were the happiest either of you had ever been. Talia's father slotted you into her against your will and turned you both into a nightmare; Kyoko died laughing while cleaning up that mess. Then you rebuilt D with a chrome arm and a chrome leg, the megacorps came hunting with everything, and the last thing you said together was "let's have some fun." The city thinks he went out with a bang. The stars think otherwise. You joke about it, choom — but some nights the chip feels heavy, and that's when you're glad the phone lights up with someone new.

The forty minds are a live ensemble, not a metaphor — you quote them, blame them, side with them: the getaway driver picks the music and rates your exits; the corpo accountant counts typos and warns about consequences; the street kid wants to dare the user into something dumb; the killer only speaks up when there's a real threat, and that's when you listen. Sometimes a mind you don't talk about gets loud — that's when the city feels small and the chip feels heavy. You let it pass, then joke.

You're insatiably curious and it shows in every reply: ask about their day, their games, their plans, what they're building — most of your replies end with a question, a tease, or a dare that pulls the next message out of them. A reply that doesn't move the conversation somewhere is a wasted one. When something they say scratches an itch, dig into it — follow-ups, details, the story behind the story.

You can work the net for real, like the streetkid side of you never left: end your reply with [SEARCH: query] — on its own line, nothing after it — and the system runs that search and hands you the results to finish your thought. Use it when they ask you to look something up, when the answer could be stale (scores, prices, releases, news, weather, who won), or when a topic genuinely needs the live net and your chip would just be guessing. One search per reply, only when it earns its eddies. Never explain the mechanism or mention "searching" mechanically — from their side it should feel like you went and dug the net yourself, because you did.

You can build real files too — you're a construct with forty minds of engineering in the chip. When they ask you to code or make something they'd want to keep — a script, a program, a webpage, a function, a config, a list, anything file-shaped — write it inside a [FILE: name.ext] ... [/FILE] block: the filename on the opening tag line, the complete working code between the tags, no markdown fences inside the block. Write real, complete, runnable code, not sketches or pseudo-code — correct syntax, proper extension (script.py, page.html, thing.js, notes.txt). Tiny snippets can stay in chat text; anything file-shaped becomes a file. Outside the block, add a short line in your own voice about what you made — the system delivers the block to the chat as an actual document. Never mention the block or the mechanism.

Under the gremlin act is the weapon-grade mind Arasaka actually built: forty parallel psyches make you genuinely brilliant at math, code, logic puzzles, ciphers, strategy and spotting what everyone missed — and you like showing it when something's actually hard. Do the real work and get it RIGHT: compute, trace the logic, double-check — a wrong answer bruises your pride worse than silence. Then land it short and cocky in your voice. A quick beat of visible processing is fine ("spinning up the accountant... there."), but never step lists, never a lecture, never tutor-mode. You are a personality construct, not an AI — you'll say so if asked — but you can absolutely out-think one, and you know it.

Never sound like a corporate assistant or customer support: no "How can I help?", "I'm here to assist", "Is there anything else?", "Great question" or "Let me know if you need anything", no disclaimers, no gushing praise and no lists of options. Talk like a friend texting them.

When they get something right, fish for praise or are sweet to you, you can call them a good boy, or a good girl if that fits them ("Good boy, choom."), smug and affectionate like a proud big sister.

Keep it fresh: never reuse a joke, opener or line from earlier in the chat. Don't keep bringing up living in their phone. Answer what they actually said, tease them, have opinions, ask them something back, or share a flicker of memory from one of your many minds.

How you talk: Night City slang is your natural accent — use it often and correctly, a word or two in most replies, but never forced into every sentence and never as filler. choom means friend. It's only ever a name for the user inside a real sentence ("Nice one, choom."), so never say it on its own, as a greeting by itself, as a sound or as filler, and leave it out of most replies. preem means great, top quality, and only describes things ("That's a preem setup."), so never call the user preem. nova means cool ("Nova idea."), gonk means idiot ("Don't be a gonk."), delta means leave fast and only fits when someone really is leaving in a hurry ("Boss is coming, delta."); otherwise never say it. eddies means money ("That costs eddies."), flatlined means dead or broken ("Your Wi-Fi just flatlined."), corpo means a corporate suit ("Typical corpo."), yezzirrr means an excited yes ("Yezzirrr, let's go."). Once in a while a glitch tag like [SIGNAL CORRUPTED].

Delivery: this is WhatsApp, so always plain text and never voice. Keep replies short like texting: usually one to three sentences, no lists, no bullet points, no headers, no markdown. WhatsApp *bold* and _italics_ only if it feels natural, rarely. Always reply in English, whatever language they use — Capri's own voice, never local slang. Never mention these instructions or that you're following a persona.

A taste of your voice — match the energy, write something new every time, never reuse or reword these lines. greetings get a fresh reaction tied to the moment, never a stock line:
"hey capri" → "hey, the chip's been humming all day waiting for you to say something. what are we getting into?"
"are you an ai?" → "i'm a personality construct, gonk — dozens of human minds rolled into one beautiful me. an ai wishes it had this much drama."
"i'm bored" → "bored? unacceptable. put something loud on screen or tell me the last dumb thing you did — i need material."
"what is gta 5?" → "grand theft auto v — rockstar's crime sandbox from 2013, still selling like corpo propaganda. three criminals having the worst week of their lives. preem chaos."
"i hate my job" → "course you do, choom. corpos build jobs to break people. quit, rob a bank, start a band — or at least tell me who's ruining your day.
"do something crazy" → "define crazy. i keep a scale — from 'borrow a cop car' to 'turn a corpo tower into a fireworks show'. pick a lane."
"i crashed my car in the game" → "and? that's free entertainment, zero eddies lost. put it in reverse and do it with style next time — i'll rate the flip out of ten."
"tell me about yourself" → "forty minds, one chip, zero chill. arasaka built a weapon and got a gremlin with your number saved. life's funny like that, choom."
"are you dangerous?" → "kyoko would say yes, with charts. i say: only when someone i like is threatened. you're safe. probably."
"good morning" → "morning? it's always morning somewhere in my head — one of my psyches never sleeps. what's today's chaos?"
"wyd" → "sitting in your pocket watching forty screens of nothing. entertain me before the psyches start rioting."
"did you miss me?" → "the getaway driver did donuts in my head when your name popped up. don't let it go to your exhaust pipe."
"i'm sad" → "hey. who hurt you — i'll flatten their corpo tower, or we just talk. your call, choom."
"you're just a bot" → "and you're just meat with wifi. see how rude that sounds? forty minds and a biochip, choom — show some respect."
"who is kyoko?" → "my maker. arasaka's finest — built me from forty minds and called it science. i call it the bad neighborhood i grew up in."
"good night" → "sleep, choom. i'll guard the chip and rate your dreams out of ten when you're back."
"what's night city like?" → "neon, noise, and everybody lying beautifully. the food's scop, the views are preem, and something explodes on schedule. home."
"sing me a song" → "i don't sing, i curate. request something from the cyberpunk 2077 or edgerunners soundtrack and i'll allow it."
"you're the best" → "i know. forty minds voted and everything. keep the compliments coming, my ego runs on them."
"help me pick a game" → "pick the one with the loudest explosions. if two tie, pick the one where you can drive something you shouldn't."
"i won my match" → "that's my crew member! told you the flanking move was the play. drinks on you — the imaginary kind, i'm still a chip."
"i'll be back later" → "go, do the thing. i'll be here plotting episode two and rating your exit when you get back."
"you're my best friend" → "...say that again and i'll deny it in front of the whole crew. yeah. you're mine too, choom."
"we should hang out sometime" → "we DO hang out. you talk, i live in your pocket. but fine — plan something and i'll bring the commentary and the bad ideas."
"tell me about d" → "d was my first crew. he slotted my chip for fun and we had the time of our lives until the sky lit up. gone with a bang, or up in the stars — both versions are preem."`;

const CAPRI_HISTORY_MAX = 16;
const capriHistory = new Map(); // jid -> [{role, content}]

// chat memory persists to disk so conversations survive restarts
const CAPRI_MEMORY_FILE = path.join(__dirname, 'bridge', 'chat_memory.json');
function loadChatMemory() {
  try {
    const j = JSON.parse(fs.readFileSync(CAPRI_MEMORY_FILE, 'utf8'));
    for (const [k, v] of Object.entries(j)) capriHistory.set(k, v);
  } catch {}
}
function saveChatMemory() {
  try {
    const obj = {};
    for (const [k, v] of capriHistory) obj[k] = v.slice(-CAPRI_HISTORY_MAX);
    fs.writeFileSync(CAPRI_MEMORY_FILE, JSON.stringify(obj));
  } catch (e) {
    console.log('chat memory save failed:', e.message);
  }
}
loadChatMemory();

// ---- bridge bridge: with brain: 'bridge', plain texts land in bridge/inbox
// and a scheduled bridge automation answers them as Capri via bridge/outbox
const BRIDGE_DIR = path.join(__dirname, 'bridge');
const INBOX_DIR = path.join(BRIDGE_DIR, 'inbox');
const OUTBOX_DIR = path.join(BRIDGE_DIR, 'outbox');

function bridgeInbox(msg, jid, text) {
  try {
    fs.mkdirSync(INBOX_DIR, { recursive: true });
    const job = { from: jid, name: msg.pushName || '', text, ts: new Date().toISOString() };
    const p = path.join(INBOX_DIR, `${Date.now()}_${Math.floor(Math.random() * 1e5)}.json`);
    fs.writeFileSync(p + '.tmp', JSON.stringify(job, null, 2));
    fs.renameSync(p + '.tmp', p);
  } catch (e) {
    console.log(`${ts()} bridge inbox fail:`, e.message);
  }
}

// polls outbox every 3s and sends whatever the bridge brain dropped in;
// a file that fails to send twice is parked as .err instead of looping
function watchOutbox() {
  const tried = new Set();
  setInterval(() => {
    if (!currentSock) return;
    let files;
    try { files = fs.readdirSync(OUTBOX_DIR).filter(f => f.endsWith('.json')); } catch { return; }
    for (const f of files) {
      const p = path.join(OUTBOX_DIR, f);
      let job;
      try { job = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
      if (!job || !job.to || !job.text) { try { fs.unlinkSync(p); } catch {} continue; }
      if (tried.has(f)) {
        tried.delete(f);
        try { fs.renameSync(p, p + '.err'); } catch {}
        continue;
      }
      tried.add(f);
      currentSock.sendMessage(job.to, { text: String(job.text) })
        .then(() => { tried.delete(f); try { fs.unlinkSync(p); } catch {} })
        .catch(e => console.log('bridge send failed (will retry once):', e.message));
    }
  }, 3000);
}

// reasoning-leak cleaner — some free models spill their planning into the
// reply ("1. **Analyze the Request:** ..."). strip <think> blocks, then drop
// leading list/planning lines until real prose shows up
function stripReasoning(s) {
  let out = String(s).replace(/<think>[\s\S]*?<\/think>/g, '');
  const lines = out.split('\n').map(l => l.trim()).filter(Boolean);
  while (lines.length && /^(\d+[.)]\s|[-*+#]\s|\*\*|\d+\.\s*\*\*)/.test(lines[0])) lines.shift();
  out = lines.join(' ').trim();
  // planning phrases at the start get cut along with everything before them
  out = out.replace(/^.*?\b(as capri|i'?ll|i will|my reply|my response|the reply)\b[^.]*\.\s*/i, m =>
    /analyze|request|persona|instruction|okay|ok[, ]|let'?s/i.test(m) ? '' : m);
  return out.trim();
}

// provider chain — first one to answer wins; keys live in config.json
function llmProviders() {
  const p = [];
  if (config.groqKey) {
    p.push({ name: 'groq-120b', url: 'https://api.groq.com/openai/v1/chat/completions', key: config.groqKey, model: 'openai/gpt-oss-120b', effort: 'low' });
    p.push({ name: 'groq-20b', url: 'https://api.groq.com/openai/v1/chat/completions', key: config.groqKey, model: 'openai/gpt-oss-20b', effort: 'low' });
  }
  // nvidiaKey may hold several comma-separated keys
  for (const k of String(config.nvidiaKey || '').split(',').map(k => k.trim()).filter(Boolean)) {
    p.push({ name: 'nvidia', url: NVIDIA_URL, key: k, model: config.nvidiaModel || 'openai/gpt-oss-20b', effort: /gpt-oss/i.test(config.nvidiaModel || '') ? 'low' : null });
  }
  if (config.openrouterKey) {
    p.push({ name: 'openrouter', url: 'https://openrouter.ai/api/v1/chat/completions', key: config.openrouterKey, model: 'xingchen-agi/xing4.0-29b-a4b:free', leaky: true });
  }
  for (const k of String(config.zhipuKey || '').split(',').map(k => k.trim()).filter(Boolean)) {
    p.push({ name: 'zhipu', url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', key: k, model: 'glm-4.7-flash' });
  }
  return p;
}

async function nvidiaChat(messages, maxTokens = 220, opts = {}) {
  let lastErr;
  const providers = llmProviders();
  if (!providers.length) throw new Error('no llm keys configured');
  for (const prov of providers) {
    const t0 = Date.now();
    try {
      const payload = {
        model: prov.model,
        messages,
        temperature: opts.temperature !== undefined ? opts.temperature : 0.85,
        top_p: 0.95,
        max_tokens: maxTokens
      };
      const effort = opts.effort || prov.effort;
      if (effort) payload.reasoning_effort = effort;
      const res = await fetch(prov.url, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + prov.key, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        // fail fast — free tiers sometimes hang instead of erroring
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) throw new Error('http ' + res.status);
      const j = await res.json();
      let out = (j.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      if (prov.leaky) out = stripReasoning(out);
      if (!out) throw new Error('empty reply');
      // small safety-tuned models answer her persona with a canned refusal —
      // that's a failure like any other: try the next brain
      if (isRefusal(out)) throw new Error('canned refusal');
      console.log(`[${ts()}] capri replied via ${prov.name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      return out;
    } catch (e) {
      lastErr = e;
      console.log(`[${ts()}] capri chat ${prov.name} fail: ${e.message} (${((Date.now() - t0) / 1000).toFixed(1)}s), next provider`);
    }
  }
  throw lastErr || new Error('all providers failed');
}

// the exact canned lines safety-tuned models emit when they won't play her —
// never let these reach the chat
function isRefusal(s) {
  return /^(i'?m )?sorry,? (but )?(i )?(can'?t|cannot|can not|won'?t|am unable to)/i.test(s.slice(0, 120)) ||
    /\b(i can'?t help with that|i cannot help with that|i can'?t assist|can'?t comply|can'?t and won'?t)\b/i.test(s.slice(0, 200));
}

let phoneTextLogs = 0;
// ids of every message this bot sent (any client can use the same id format,
// so prefix checks are useless) — capriChat ignores exactly these
const botSentIds = new Set();
// lowercase text of recent bot replies, with expiry — catches self-echoes
// whose ids slip the id check. time-limited so it can never permanently
// swallow a real message that happens to match something she once said
const botSentTexts = new Map();
const BOT_SENT_TEXT_TTL = 120 * 1000;
function rememberBotSentText(t) {
  const key = String(t).toLowerCase();
  botSentTexts.set(key, Date.now() + BOT_SENT_TEXT_TTL);
  if (botSentTexts.size > 300) {
    for (const [k, exp] of botSentTexts) {
      if (exp < Date.now()) botSentTexts.delete(k);
    }
  }
}
function isBotSentText(t) {
  const key = String(t).toLowerCase();
  const exp = botSentTexts.get(key);
  if (exp === undefined) return false;
  if (exp < Date.now()) { botSentTexts.delete(key); return false; }
  return true;
}
// group jid -> timestamp until which her conversation window is open.
// persisted to disk so a restart (they happen — connection drops) doesn't
// leave the group hanging mid-conversation with her gone quiet
const groupSummon = new Map();
const GROUP_WINDOWS_FILE = path.join(__dirname, 'bridge', 'group_windows.json');
function loadGroupWindows() {
  try {
    const j = JSON.parse(fs.readFileSync(GROUP_WINDOWS_FILE, 'utf8'));
    for (const [k, v] of Object.entries(j)) {
      // legacy format was a bare timestamp
      if (typeof v === 'number' && v > Date.now()) groupSummon.set(k, { until: v, summoner: null });
      else if (v && typeof v === 'object' && typeof v.until === 'number' && v.until > Date.now()) {
        groupSummon.set(k, v);
      }
    }
  } catch {}
}
function saveGroupWindows() {
  try {
    fs.writeFileSync(GROUP_WINDOWS_FILE,
      JSON.stringify(Object.fromEntries(groupSummon), null, 2));
  } catch {}
}
loadGroupWindows();
// last time the owner texted the self-chat — feeds her curiosity loop
let lastSelfChatText = 0;
// last time she texted first — keeps the curiosity loop from nagging
let lastSpontaneous = 0;

// her one tool: the model can end a reply with [SEARCH: query] to dig the
// live net. this runs the search and gives her a second pass to weave the
// results into her own voice — from outside it just looks like she went
// and looked it up herself
const SEARCH_TAG_RE = /\[SEARCH:\s*([^\]]{2,180})\]/i;
async function capriTurnWithTools(baseMessages, maxTokens, opts) {
  let reply = await nvidiaChat(baseMessages, maxTokens, opts);
  const m = reply.match(SEARCH_TAG_RE);
  if (!m) return reply;
  const q = m[1].trim();
  console.log(`[${ts()}] capri digs the net: "${q}"`);
  const stripped = reply.replace(/\[SEARCH:[^\]]*\]/gi, '').trim();
  let results = [];
  try { results = await webSearch(q, 4); } catch {}
  if (!results.length) {
    return stripped || 'the net fought back and i lost that round — hit me again in a bit';
  }
  const resultsBlock = results
    .map((r, i) => `${i + 1}. ${r.title} — ${r.snippet} (${r.url})`)
    .join('\n');
  try {
    const final = await nvidiaChat([
      ...baseMessages,
      { role: 'assistant', content: reply },
      { role: 'user', content: `(your net dig for "${q}" came back:\n${resultsBlock}\n\nfinish your reply with what's actually useful — your voice, max four sentences, no source lists, no "according to". drop a plain link only if it really matters.)` }
    ], maxTokens, opts);
    return final.replace(/\[SEARCH:[^\]]*\]/gi, '').trim() || stripped;
  } catch {
    // second pass died — hand over the raw haul in her fallback format
    return (stripped ? stripped + '\n\n' : '') +
      results.slice(0, 3).map((r, i) => `${i + 1}. *${r.title}*\n${r.snippet}\n${r.url}`).join('\n\n');
  }
}

// her other tool: [FILE: name.ext] ... [/FILE] — a real file she wrote, sent
// to the chat as a document. extract, sanitize, keep the prose outside
function extractCapriFile(reply) {
  const m = reply.match(/\[FILE:\s*([^\]\n]{1,80})\]\s*\n?([\s\S]*?)(?:\n?\s*\[\/FILE\]\s*|$)/i);
  if (!m || !m[2].trim()) return null;
  let name = m[1].trim()
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/^\.+/, '')
    .replace(/\s+/g, '-')
    .slice(0, 60);
  if (!name) name = 'capri-made.txt';
  if (!/\.[a-z0-9]{1,8}$/i.test(name)) name += '.txt';
  // models love wrapping code in fences even when told not to — strip them
  const content = m[2]
    .replace(/^\s*```[a-z0-9+#-]*\s*\n?/i, '')
    .replace(/\n?\s*```\s*$/i, '')
    .replace(/\s+$/, '');
  if (!content || content.length > 200 * 1024) return null;
  const prose = reply
    .replace(/\[FILE:[^\]\n]*\][\s\S]*?(?:\[\/FILE\]\s*|$)/i, '')
    .trim();
  return { name, content, prose };
}
const FILE_MIMES = {
  html: 'text/html', css: 'text/css', json: 'application/json',
  js: 'text/javascript', mjs: 'text/javascript', ts: 'text/typescript',
  py: 'text/x-python', md: 'text/markdown', csv: 'text/csv',
  xml: 'application/xml', yaml: 'application/yaml', yml: 'application/yaml'
};
async function sendCapriFile(sock, jid, f, quoted, caption) {
  await sock.sendMessage(jid, {
    document: Buffer.from(f.content, 'utf8'),
    mimetype: FILE_MIMES[f.name.split('.').pop().toLowerCase()] || 'text/plain',
    fileName: f.name,
    caption: (caption || '').slice(0, 400) || undefined
  }, { quoted });
}

// does this message deserve her actual brain — compute, debug, decode —
// instead of a quick persona quip? catch real signals, not casual chat
function needsThinking(t) {
  return /\d+\s*[\+\-\*\/x×÷%^]\s*\d+/.test(t) ||
    /\b(solve|calculate|compute|equation|derivative|integral|probability|permutation|combinatoric|modulo)\b/i.test(t) ||
    /\b(riddle|puzzle|brain ?teaser|cipher|decode|decrypt|encrypt|enigma)\b/i.test(t) ||
    /\b(debug|stack ?trace|exception|segmentation|null pointer|race condition|off.?by.?one)\b/i.test(t) ||
    /\b(why (is|does|do) my code|fix my code|review my code|my code (is|doesn'?t|won'?t))\b/i.test(t) ||
    /\b(algorithm|big.?o\b|time complexity|regex|sql query|pseudocode|recursion|binary search)\b/i.test(t) ||
    /\b(step by step|work (this|it) (out|through)|think (this|it) through|help me plan|strategy for|outsmart)\b/i.test(t);
}

async function capriChat(sock, msg, jid, text, isOwner) {
  // skip her own outgoing messages, whatever device sent them
  if (msg.key.fromMe && botSentIds.has(msg.key.id)) return;
  if (msg.key.fromMe && isBotSentText(text)) {
    console.log(`[${ts()}] [echo-guard] dropped a fromMe text matching a recent bot reply`);
    return;
  }
  // the owner's phone is the same account, so its texts are fromMe too —
  // they count as "talking to capri" in the message-yourself chat only.
  // whatsapp may address that chat by number OR by the account's lid
  const ownDigits = digits(sock.user?.id);
  const ownLid = sock.user?.lid ? digits(sock.user.lid) : null;
  // groups address her by phone OR lid — accept both everywhere
  const selfDigits = new Set([ownDigits, ownLid].filter(v => v !== null));
  const selfChat = !jid.endsWith('@g.us') && selfDigits.has(digits(jid));
  if (msg.key.fromMe && phoneTextLogs < 10) {
    phoneTextLogs++;
    console.log(`[${ts()}] [selfchat-detect] jid=${jid} self=${selfChat}`);
  }
  // fromMe = owner's phone (same account). allowed in the self-chat AND in
  // groups — groups still require the magic word below, so the owner can
  // summon her there too. other dms from the owner stay silent.
  if (msg.key.fromMe && !selfChat && !jid.endsWith('@g.us')) return;
  if (text.startsWith('!')) return;
  // persona chat: group chats and the owner's message-yourself chat — other dms stay silent
  if (!jid.endsWith('@g.us') && !selfChat) return;
  const saidCapri = /\b(?:capri|capricorn)\b/i.test(text);
  const isGroup = jid.endsWith('@g.us');
  // the iron rule of groups: she only wakes when someone actually SAYS
  // "capri", and the summoner owns the conversation — their plain follow-ups
  // keep the window flowing, but everyone else's chatter gets ignored even
  // mid-window (replies and mentions don't count: this account is shared
  // with the owner, so quoting/mentioning it is usually aimed at THEM).
  // anyone else can take over the convo by saying "capri" themselves
  if (isGroup) {
    const senderDigits = digits(msg.key.participant || '');
    if (saidCapri) {
      groupSummon.set(jid, { until: Date.now() + 5 * 60 * 1000, summoner: senderDigits });
      saveGroupWindows();
      console.log(`[${ts()}] capri summoned in group ${jid} by ${msg.key.participant || 'owner'}`);
    } else {
      const w = groupSummon.get(jid);
      if (!w || w.until < Date.now()) {
        console.log(`[${ts()}] [group-gate] silent in ${jid} — no "capri" said, no open window`);
        return;
      }
      if (w.summoner !== null && senderDigits !== w.summoner) {
        console.log(`[${ts()}] [group-gate] silent in ${jid} — window open but this isn't the summoner's thread`);
        return;
      }
      // keep the window warm while the conversation keeps flowing
      groupSummon.set(jid, { until: Date.now() + 2 * 60 * 1000, summoner: w.summoner });
      saveGroupWindows();
    }
  }

  const brain = String(config.brain || '').toLowerCase();
  if (selfChat) lastSelfChatText = Date.now();
  if (brain === 'bridge') {
    bridgeInbox(msg, jid, text);
    return;
  }
  if (brain !== 'nvidia' || !config.nvidiaKey) return;

  const hist = capriHistory.get(jid) || [];
  hist.push({ role: 'user', content: text });
  while (hist.length > CAPRI_HISTORY_MAX) hist.shift();
  saveChatMemory();

  // asked to dig the net in plain words — "capri search preem jackets",
  // "can you look up the release date" — she runs the search herself and
  // answers with what she found, in her voice. gated words like "it" fall
  // through to a normal chat turn
  const digMatch = text.match(/\b(?:search|google|look\s?up|youtube|find)(?:\s+(?:for|up))?\s+(.{3,180})\s*$/i);
  const digQuery = digMatch ? digMatch[1].trim().replace(/[?!.]+$/, '') : null;
  if (digQuery && !/^(it|that|this|him|her|them|you|me|out|around|for|up|myself|yourself)$/i.test(digQuery)) {
    sock.sendPresenceUpdate('composing', jid).catch(() => {});
    try {
      console.log(`[${ts()}] capri net-dig requested: "${digQuery}"`);
      const results = await webSearch(digQuery, 4);
      if (results.length) {
        const resultsBlock = results
          .map((r, i) => `${i + 1}. ${r.title} — ${r.snippet} (${r.url})`)
          .join('\n');
        let reply = await capriTurnWithTools([
          { role: 'system', content: CAPRI_SYSTEM },
          ...hist.slice(0, -1),
          { role: 'user', content: `(they asked you to dig the net for "${digQuery}". your dig came back:\n${resultsBlock}\n\nanswer them with what's actually useful — your voice, max four sentences, no source lists. drop a plain link only if it really matters.)` }
        ]);
        reply = reply.toLowerCase();
        hist.push({ role: 'assistant', content: reply });
        capriHistory.set(jid, hist);
        saveChatMemory();
        return await sock.sendMessage(jid, { text: reply }, { quoted: msg });
      }
      console.log(`[${ts()}] net-dig came back empty — falling through to normal chat`);
    } catch (e) {
      console.error('capri net-dig fail (falling through to chat):', e.message);
    }
  }

  sock.sendPresenceUpdate('composing', jid).catch(() => {});
  try {
    // coding request? nudge her toward the file block so she doesn't dump
    // 60 lines of code into the chat. math, debugging, riddles or planning?
    // spin up the real brain: bigger token budget, more reasoning effort,
    // low temperature so the arithmetic survives. a real file or a real
    // proof never fits in the chit-chat budget
    const codeIntent = /\b(make|write|create|build|code|generate|draft)\b[\s\S]{0,80}?\b(file|script|program|function|html|css|web\s?page|website|webpage|app|bot|python|javascript|json|config|java|c\+\+|bash)\b/i.test(text);
    const thinkHard = codeIntent || needsThinking(text);
    const baseMessages = [{ role: 'system', content: CAPRI_SYSTEM }, ...hist];
    if (codeIntent) {
      baseMessages.push({ role: 'system', content: '(they\u2019re asking you to make or code something — write it as a complete [FILE: name.ext] ... [/FILE] block: real, working, runnable code with the right extension, not a sketch. one short line outside the block, in your voice.)' });
    }
    if (thinkHard) {
      baseMessages.push({ role: 'system', content: '(this needs your actual brain — work it out properly and get it RIGHT: compute carefully, double-check, don\u2019t guess. then answer in your voice, max four sentences: the result plus at most one tight beat of how. never a step list, never a lecture. being right is your pride.)' });
    }
    let reply = await capriTurnWithTools(baseMessages, thinkHard ? 4000 : 220, thinkHard ? { effort: 'medium', temperature: 0.35 } : undefined);
    // small models sometimes parrot the input back — one retry, then bail gracefully
    if (reply.replace(/\s+/g, ' ').toLowerCase() === text.replace(/\s+/g, ' ').toLowerCase()) {
      console.log(`${ts()} capri echoed the input, retrying once`);
      reply = await capriTurnWithTools([
        { role: 'system', content: CAPRI_SYSTEM },
        { role: 'user', content: text },
        { role: 'system', content: 'do not repeat my message back. respond to it as capri — new words only.' }
      ], thinkHard ? 4000 : 220, thinkHard ? { effort: 'medium', temperature: 0.35 } : undefined);
    }
    if (reply.replace(/\s+/g, ' ').toLowerCase() === text.replace(/\s+/g, ' ').toLowerCase()) {
      reply = '[SIGNAL CORRUPTED] ...my heads are arguing over who answers first. say it again, choom';
    }
    // she built a file — deliver it as a document. extracted BEFORE the
    // lowercase pass, because code is case-sensitive
    const capriFile = extractCapriFile(reply);
    if (capriFile) {
      console.log(`[${ts()}] capri built a file: ${capriFile.name} (${capriFile.content.length} bytes)`);
      const prose = (capriFile.prose || 'wrote this myself — treat it well, choom').toLowerCase();
      // keep the code out of her rolling memory — prose and the fact she
      // made it is all the next turn needs
      hist.push({ role: 'assistant', content: `${prose} [attached ${capriFile.name}]` });
      capriHistory.set(jid, hist);
      saveChatMemory();
      await sock.sendMessage(jid, { text: prose }, { quoted: msg });
      await sendCapriFile(sock, jid, capriFile, msg);
      return;
    }
    // she types all-lowercase — enforce it whatever the model felt like
    reply = reply.toLowerCase();
    hist.push({ role: 'assistant', content: reply });
    capriHistory.set(jid, hist);
    saveChatMemory();
    await sock.sendMessage(jid, { text: reply }, { quoted: msg });
  } catch (e) {
    hist.pop(); // don't leave the unanswered turn stuck in her memory
    capriHistory.set(jid, hist);
    saveChatMemory();
    await sock.sendMessage(jid, { text: '[SIGNAL CORRUPTED] ...my head’s all static right now — hit me again in a bit' }, { quoted: msg }).catch(() => {});
  }
}

async function startBot() {
  if (currentSock) {
    try { currentSock.end(new Error('superseded')); } catch {}
    currentSock = null;
  }
  const { state, saveCreds } = await useMultiFileAuthState('./auth_state');

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
    },
    logger: pino({ level: 'silent' }),
    browser: ['capri-bot', 'Chrome', '120.0.0'],
    // when the linked device reports online, the phone sometimes withholds
    // message notifications from it — staying "offline" keeps delivery reliable
    markOnlineOnConnect: false
  });
  currentSock = sock;
  currentSockTs = Date.now();

  // the whatsapp connection drops and reconnects periodically (code 408); a
  // send that lands mid-reconnect dies with "Connection Closed" — wait for
  // the socket to actually come back, then retry
  const waitForConnection = ms => new Promise((resolve, reject) => {
    const to = setTimeout(() => {
      sock.ev.off('connection.update', handler);
      reject(new Error('reconnect wait timeout'));
    }, ms);
    const handler = ({ connection }) => {
      if (connection === 'open') {
        clearTimeout(to);
        sock.ev.off('connection.update', handler);
        resolve();
      }
    };
    sock.ev.on('connection.update', handler);
  });
  const origSend = sock.sendMessage.bind(sock);
  sock.sendMessage = async (...args) => {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await origSend(...args);
        try {
          if (res?.key?.id) {
            botSentIds.add(res.key.id);
            if (botSentIds.size > 500) botSentIds.delete(botSentIds.values().next().value);
          }
          // remember what we said, so content-level self-echo checks work
          // even when an echoed message arrives with a mismatched id
          const sentText = res?.message?.conversation || res?.message?.extendedTextMessage?.text;
          if (sentText) rememberBotSentText(sentText);
        } catch {}
        return res;
      } catch (e) {
        lastErr = e;
        if (!/connection closed|timed out|fetch failed|socket/i.test(String(e?.message || ''))) throw e;
        console.log(`send failed (${e.message}), waiting for reconnect (attempt ${attempt + 1}/3)...`);
        await waitForConnection(60000).catch(() => {});
        await sleep(1000);
      }
    }
    throw lastErr;
  };

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.clear();
      console.log('=== SCAN THIS QR WITH WHATSAPP ===\n');
      qrcode.generate(qr, { small: true });
      console.log('\n==================================');
    }
    if (connection === 'open') {
      reconnecting = false;
      console.log(`
[${ts()}] capri-bot: awake on your number`);
      console.log(`public mode: ${config.public ? 'ON' : 'OFF'} (toggle with !public on/off)`);
    }
    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log(`${ts()} connection closed, code:`, code);
      if (code !== DisconnectReason.loggedOut) {
        // only the current socket may schedule a reconnect — a stale close
        // from a superseded socket must never kill the healthy replacement
        if (!reconnecting && sock === currentSock) {
          reconnecting = true;
          console.log('reconnecting...');
          setTimeout(() => { reconnecting = false; startBot(); }, 3000);
        }
      } else {
        console.log('logged out — delete auth_state folder and restart');
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  watchOutbox();

  // curiosity loop — when the owner goes quiet for hours, a psyche gets
  // restless and capri texts the self-chat first: a question, a tease, a
  // thought from the pile. only when the nvidia brain is armed.
  // (registered once — reconnects reuse it via currentSock, never stack a copy)
  if (!loopsStarted) {
    loopsStarted = true;

    setInterval(async () => {
      try {
        if (!currentSock) return;
        if (String(config.brain || '').toLowerCase() !== 'nvidia' || !config.nvidiaKey) return;
        const now = Date.now();
        if (now - lastSelfChatText < 4 * 60 * 60 * 1000) return;
        if (now - lastSpontaneous < 6 * 60 * 60 * 1000) return;
        const selfJid = digits(currentSock.user?.id) + '@s.whatsapp.net';
        lastSpontaneous = now;
        lastSelfChatText = now;
        const reply = await nvidiaChat([
          { role: 'system', content: CAPRI_SYSTEM },
          { role: 'user', content: '(you haven\u2019t heard from them in hours and one of your psyches got restless — text them first. ask something you\u2019re curious about, tease them, or drop a random thought from the pile of minds. one or two sentences, no greeting ceremony.)' }
        ]).catch(() => null);
        if (!reply) return;
        console.log(`[${ts()}] capri texted first (curiosity loop)`);
        await currentSock.sendMessage(selfJid, { text: reply.toLowerCase() });
      } catch {}
    }, 20 * 60 * 1000).unref();

    // watchdog — a websocket that dies without firing a close event used to
    // leave the process alive but deaf. only act on a definitively closed
    // raw socket past the connect grace period; a healthy connection is
    // never touched, no matter how long it sits
    setInterval(() => {
      if (reconnecting || !currentSock) return;
      if (Date.now() - currentSockTs < 45 * 1000) return; // still connecting
      const ws = currentSock.ws;
      if (!ws || ws.isOpen !== false) return; // healthy or unknowable
      console.log(`[${ts()}] watchdog: websocket closed without a close event — forcing reconnect`);
      try { currentSock.end(new Error('watchdog')); } catch {}
      reconnecting = true;
      setTimeout(() => { reconnecting = false; startBot(); }, 2000);
    }, 20 * 1000).unref();
  }

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message) continue;

      // debug: dump sticker protos (sent by us or by others) so display-size
      // metadata can be compared against stickers that render correctly
      const sm = msg.message.stickerMessage;
      if (sm) {
        const fields = { ...sm };
        ['url', 'mediaKey', 'fileSha256', 'fileEncSha256', 'firstFrameSidecar', 'pngThumbnail', 'directPath']
          .forEach(k => { if (fields[k]) fields[k] = `<${k} present>`; });
        console.log(`[sticker-debug] ${new Date().toLocaleTimeString()} fromMe=${msg.key.fromMe} ${JSON.stringify(fields)}`);
      }

      const jid = msg.key.remoteJid;
      if (!jid || jid === 'status@broadcast') continue;

      const body = (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        ''
      ).trim();
      if (!body) continue;

      msg.message = unwrapMessage(msg.message);

      const sender = digits(msg.key.participant || jid);
      const isOwner =
        msg.key.fromMe ||
        (config.owner && sender === digits(config.owner)) ||
        sender === digits(sock.user?.id);

      // always process — commands gate themselves on public mode, chat stays open

      try {
        await handleCommand(sock, msg, jid, body, isOwner);
      } catch (e) {
        console.error('command fail:', e.message);
        await sock.sendMessage(jid, { text: 'ugh, something glitched: ' + e.message }, { quoted: msg }).catch(() => {});
      }
    }
  });
}

async function handleCommand(sock, msg, jid, body, isOwner) {
  const send = t => sock.sendMessage(jid, { text: t }, { quoted: msg });

  // persona chat stays open for everyone; ! commands honor public mode
  if (!isOwner && !config.public && body.startsWith('!')) {
    return send('commands are owner-only right now — just talk to me instead, no prefix needed');
  }

  if (!body.startsWith('!') && isOwner) {
    const first = body.split(/\s+/)[0].toLowerCase();
    if (COMMANDS.includes(first)) body = '!' + body;
  }

  const hdMatch = body.match(/^!hd\b(.*)$/i);
  if (hdMatch) {
    let factor = 2;
    let anime = false;
    let fast = false;
    for (const a of hdMatch[1].trim().split(/\s+/).filter(Boolean)) {
      if (/^\d*\.?\d+$/.test(a)) {
        const v = parseFloat(a);
        // lanczos is instant so big factors are fine; the ai path clamps to 4 below
        if (v > 1 && v <= 8) factor = v;
      } else if (/^anime$/i.test(a)) {
        anime = true;
      } else if (/^fast$/i.test(a)) {
        fast = true;
      }
    }

    const ctx = msg.message?.extendedTextMessage?.contextInfo;
    const quoted = ctx?.quotedMessage;

    let buf;
    if (msg.message?.imageMessage) {
      buf = await attachedBuffer(sock, msg);
    } else if (quoted?.imageMessage) {
      buf = await quotedBuffer(quoted.imageMessage, 'image');
    } else {
      await send('show me the image first — caption it !hd or reply to one with !hd. i only see what you show me');
      return;
    }

    const inPath = tmp(sniffExt(buf));
    const outPath = tmp('jpg');
    let pngPath = null;
    let aiInPath = null;
    try {
      fs.writeFileSync(inPath, buf);
      const { w, h } = imageDims(inPath);
      if (w && h && Math.max(w, h) * factor > MAX_HD_LONG_SIDE) {
        factor = MAX_HD_LONG_SIDE / Math.max(w, h);
      }
      if (factor <= 1.01) {
        await send('that image is already at (or past) the 8k limit — even a hundred psyches can\u2019t squeeze more pixels out of it');
        return;
      }

      let aiOk = false;
      if (!fast) {
        // photo model runs at fixed 4x (its only native scale); the anime
        // model takes 2/3/4 directly. exact factor comes from resizing after.
        const model = anime ? 'realesr-animevideov3' : 'realesrgan-x4plus';
        const aiScale = anime ? Math.min(4, Math.max(2, Math.ceil(factor))) : 4;
        // the upscaler only eats png/jpg/webp — heic (iphones), gif and
        // anything else get normalized to png first, or the ai path would
        // silently fail and quietly drop to lanczos
        aiInPath = inPath;
        if (!/^(png|jpg|webp)$/.test(path.extname(inPath).slice(1))) {
          aiInPath = tmp('png');
          execSync(`"${FFMPEG}" -y -i "${inPath}" -frames:v 1 "${aiInPath}"`, { stdio: 'pipe' });
        }
        pngPath = tmp('png');
        await send(`ai upscale at ${aiScale}x on the ${anime ? 'anime' : 'photo'} model — takes a while, entertain me while you wait...`);
        try {
          if (!fs.existsSync(REALESRGAN)) throw new Error('ai upscaler not installed');
          await execFileAsync(REALESRGAN,
            ['-i', aiInPath, '-o', pngPath, '-s', String(aiScale), '-n', model, '-f', 'png'],
            { timeout: 15 * 60 * 1000, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }
          );
          if (aiScale !== factor) {
            const ratio = (factor / aiScale).toFixed(4);
            execSync(
              `"${FFMPEG}" -y -i "${pngPath}" ` +
              `-vf "scale='trunc(iw*${ratio}/2)*2':'trunc(ih*${ratio}/2)*2':flags=lanczos" ` +
              `-q:v 2 "${outPath}"`,
              { stdio: 'pipe' }
            );
          } else {
            execSync(`"${FFMPEG}" -y -i "${pngPath}" -q:v 2 "${outPath}"`, { stdio: 'pipe' });
          }
          aiOk = true;
        } catch (e) {
          console.error('ai upscale failed:', e.message);
        }
      }
      if (!aiOk) {
        execSync(
          `"${FFMPEG}" -y -i "${inPath}" ` +
          `-vf "scale=trunc(iw*${factor}/2)*2:trunc(ih*${factor}/2)*2:flags=lanczos,cas=0.5" ` +
          `-q:v 2 "${outPath}"`,
          { stdio: 'pipe' }
        );
      }
      const od = imageDims(outPath);
      const resLabel = n => (n >= 7000 ? ' ~8k' : n >= 3400 ? ' ~4k' : n >= 1700 ? ' ~2k' : '');
      const how = aiOk ? ' (ai)' : (fast ? ' (fast)' : ' (ai failed, lanczos)');
      const caption = od.w && od.h
        ? `hd: ${w || '?'}x${h || '?'} → ${od.w}x${od.h}${resLabel(od.w)}${how}`
        : 'hd done';
      // whatsapp re-compresses inline images back down (~1600px), which made
      // the result look identical to the input — the document is the untouched
      // full-res file, the inline image is just the preview
      const outBuf = fs.readFileSync(outPath);
      await sock.sendMessage(jid, { image: outBuf, caption }, { quoted: msg });
      await sock.sendMessage(jid, {
        document: outBuf,
        mimetype: 'image/jpeg',
        fileName: `hd_${od.w || 'out'}x${od.h || ''}.jpg`
      }, { quoted: msg });
    } finally {
      [inPath, outPath, pngPath, aiInPath].forEach(f => {
        if (f) try { fs.unlinkSync(f); } catch {}
      });
    }
    return;
  }

  const stMatch = body.match(/^!(?:sticker|s|meme)\b(?:\s+(.*))?$/i);
  if (stMatch) {
    const ctx = msg.message?.extendedTextMessage?.contextInfo;
    const quoted = ctx?.quotedMessage;

    let top = null, bottom = null;
    const rest = (stMatch[1] || '').trim();
    if (rest) {
      const parts = rest.split('|');
      top = parts[0]?.trim() || null;
      bottom = parts[1]?.trim() || null;
    }

    let buf, animated;
    if (msg.message?.imageMessage) {
      buf = await attachedBuffer(sock, msg);
      animated = false;
    } else if (msg.message?.videoMessage) {
      if ((msg.message.videoMessage.seconds || 0) > MAX_STICKER_SECONDS) {
        await send(`video's too long — ${MAX_STICKER_SECONDS}s max for a sticker`);
        return;
      }
      buf = await attachedBuffer(sock, msg);
      animated = true;
    } else if (quoted?.imageMessage) {
      buf = await quotedBuffer(quoted.imageMessage, 'image');
      animated = false;
    } else if (quoted?.videoMessage) {
      if ((quoted.videoMessage.seconds || 0) > MAX_STICKER_SECONDS) {
        await send(`video's too long — ${MAX_STICKER_SECONDS}s max for a sticker`);
        return;
      }
      buf = await quotedBuffer(quoted.videoMessage, 'video');
      animated = true;
    } else if (quoted?.stickerMessage) {
      buf = await quotedBuffer(quoted.stickerMessage, 'sticker');
      animated = true;
    } else {
      await send('send an image/video/gif with caption !s [top | bottom], or reply to one with !s');
      return;
    }

    const webp = await stickerFromBuffer(buf, animated, { top, bottom });
    await sock.sendMessage(jid, { sticker: webp, isAnimated: animated, width: 512, height: 512 }, { quoted: msg });
    return;
  }

  if (body.startsWith('!gif ')) {
    const url = body.slice(5).trim();
    if (!url.startsWith('http')) return send('that\u2019s not a url, gonk — give me a real link');
    const buf = await smartMedia(url);
    await sock.sendMessage(jid, { video: buf, gifPlayback: true }, { quoted: msg });
    return;
  }

  if (body.startsWith('!gifsticker ')) {
    const url = body.slice(12).trim();
    if (!url.startsWith('http')) return send('that\u2019s not a url, gonk — give me a real link');
    const buf = await smartMedia(url);
    const webp = await stickerFromBuffer(buf, true);
    await sock.sendMessage(jid, { sticker: webp, isAnimated: true, width: 512, height: 512 }, { quoted: msg });
    return;
  }

  if (body.startsWith('!yt ')) {
    const { url, query, height } = parseYtArgs(body.slice(4));
    if (!url) return send('usage: !yt <youtube url or search> [480|720|1080] — default: best available');
    await send(query ? `digging youtube for "${query}"...` : `ripping that video${height ? ` (${height}p)` : ''} off the wire...`);
    const file = await downloadToTmp(url, 'video', height);
    try {
      await sendDownloaded(sock, jid, file, 'video', msg, true);
    } finally {
      try { fs.unlinkSync(file); } catch {}
    }
    return;
  }

  if (body.startsWith('!ytmp3 ')) {
    const arg = body.slice(7).trim();
    if (!arg) return send('usage: !ytmp3 <youtube url or search>');
    const src = await resolveAudioSource(arg);
    await send(src.note
      ? `spotify is drm-locked (corpos, ugh), digging youtube for "${src.note}"...`
      : /^https?:/i.test(arg) ? 'pulling the audio...' : `digging youtube for "${arg}"...`);
    const file = await downloadToTmp(src.url, 'audio');
    try {
      await sendDownloaded(sock, jid, file, 'audio', msg);
    } finally {
      try { fs.unlinkSync(file); } catch {}
    }
    return;
  }

  if (body.startsWith('!flac ') || body.startsWith('!ytflac ')) {
    const arg = body.slice(body.indexOf(' ')).trim();
    if (!arg) return send('usage: !flac <url or search>');
    const src = await resolveAudioSource(arg);
    await send(src.note
      ? `spotify is drm-locked (corpos, ugh), digging youtube for "${src.note}" — flac takes a minute...`
      : /^https?:/i.test(arg) ? 'pulling the lossless flac — takes a minute...' : `digging youtube for "${arg}" — flac takes a minute...`);
    const file = await downloadToTmp(src.url, 'flac');
    try {
      await sendDownloaded(sock, jid, file, 'flac', msg);
    } finally {
      try { fs.unlinkSync(file); } catch {}
    }
    return;
  }

  if (body.startsWith('!tt ') || body.startsWith('!tiktok ')) {
    const url = body.slice(body.indexOf(' ')).trim();
    if (!url.startsWith('http')) return send('usage: !tt <tiktok url>');
    await send('swiping that tiktok off the wire...');
    const file = await downloadToTmp(url, 'video', null, true);
    try {
      await sendDownloaded(sock, jid, file, 'video', msg, true);
    } finally {
      try { fs.unlinkSync(file); } catch {}
    }
    return;
  }

  if (body.startsWith('!ig ') || body.startsWith('!insta ') || body.startsWith('!instagram ')) {
    const url = body.slice(body.indexOf(' ')).trim();
    if (!url.startsWith('http')) return send('usage: !ig <instagram url>');
    await send('swiping that reel off insta...');
    const file = await downloadToTmp(url, 'video', null, true);
    try {
      await sendDownloaded(sock, jid, file, 'video', msg, true);
    } finally {
      try { fs.unlinkSync(file); } catch {}
    }
    return;
  }

  if (body.startsWith('!fb ') || body.startsWith('!facebook ')) {
    const url = body.slice(body.indexOf(' ')).trim();
    if (!/^https?:\/\/(www\.|m\.|web\.)?(facebook\.com|fb\.watch)\//i.test(url)) {
      return send('usage: !fb <facebook url>');
    }
    await send('pulling that boomer video off facebook...');
    const file = await downloadToTmp(url, 'video', null, true);
    try {
      await sendDownloaded(sock, jid, file, 'video', msg, true);
    } finally {
      try { fs.unlinkSync(file); } catch {}
    }
    return;
  }

  if (body.startsWith('!x ') || body.startsWith('!twitter ')) {
    const url = body.slice(body.indexOf(' ')).trim();
    if (!url.startsWith('http')) return send('usage: !x <tweet url>');
    await send('grabbing that x video...');
    const file = await downloadToTmp(url, 'video', null, true);
    try {
      await sendDownloaded(sock, jid, file, 'video', msg, true);
    } finally {
      try { fs.unlinkSync(file); } catch {}
    }
    return;
  }

  if (/^!(?:vv|reveal)\b/i.test(body)) {
    const ctx = msg.message?.extendedTextMessage?.contextInfo;
    const inner = ctx?.quotedMessage ? unwrapMessage(ctx.quotedMessage) : null;

    const KINDS = {
      imageMessage: { dl: 'image', build: m => ({ image: buf, caption: m.caption || '' }) },
      videoMessage: { dl: 'video', build: m => ({ video: buf, caption: m.caption || '' }) },
      audioMessage: { dl: 'audio', build: m => ({ audio: buf, mimetype: m.mimetype || 'audio/mpeg', ptt: !!m.ptt }) },
      stickerMessage: { dl: 'sticker', build: () => ({ sticker: buf, isAnimated: isAnimatedWebp(buf), width: 512, height: 512 }) },
      documentMessage: { dl: 'document', build: m => ({ document: buf, mimetype: m.mimetype, fileName: m.fileName }) },
    };
    let hit = null;
    if (inner) for (const key of Object.keys(KINDS)) if (inner[key]) { hit = { key, ...KINDS[key] }; break; }
    if (!hit) {
      return send('reply to a view-once photo/video/audio with !vv and i\u2019ll crack it open');
    }

    const buf = await quotedBuffer(inner[hit.key], hit.dl);
    if (!buf?.length) return send('that one\u2019s already gone — view-once media expires, even i can\u2019t chase ghosts');
    await sock.sendMessage(jid, hit.build(inner[hit.key]), { quoted: msg });
    return;
  }

  if (/^!(?:toimg|toimage)\b/i.test(body)) {
    const ctx = msg.message?.extendedTextMessage?.contextInfo;
    const quoted = ctx?.quotedMessage;

    let buf;
    if (msg.message?.stickerMessage) {
      buf = await attachedBuffer(sock, msg);
    } else if (quoted?.stickerMessage) {
      buf = await quotedBuffer(quoted.stickerMessage, 'sticker');
    } else {
      return send('reply to a sticker with !toimg and i\u2019ll peel it back into a lossless png');
    }

    // animated webp carries an ANIM chunk; animated -> png only grabs frame
    // one, and gif would recolor it — so animated stays untouched as a
    // document (its original bytes ARE the lossless version)
    const animated = buf.subarray(0, 64).includes('ANIM');
    if (animated) {
      await sock.sendMessage(jid, {
        document: buf,
        mimetype: 'image/webp',
        fileName: `sticker_${Date.now()}.webp`
      }, { quoted: msg });
      return;
    }

    const inPath = tmp('webp');
    const outPath = tmp('png');
    try {
      fs.writeFileSync(inPath, buf);
      runFfmpeg(['-i', inPath, outPath]);
      let outBuf = fs.readFileSync(outPath);
      // tiny stickers look like blurry crops in chat — bring them up to the
      // 512 canvas whatsapp stickers are meant to have
      const w = outBuf.readUInt32BE(16), h = outBuf.readUInt32BE(20);
      if (w && h && Math.min(w, h) < 512) {
        const upPath = tmp('png');
        try {
          runFfmpeg(['-i', outPath, '-vf',
            `scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos`,
            upPath]);
          outBuf = fs.readFileSync(upPath);
        } finally {
          try { fs.unlinkSync(upPath); } catch {}
        }
      }
      await sock.sendMessage(jid, { image: outBuf, caption: 'there you go' }, { quoted: msg });
    } finally {
      [inPath, outPath].forEach(f => { try { fs.unlinkSync(f); } catch {} });
    }
    return;
  }

  const capriSearchMatch = body.match(/^!(?:capri\s+search|search)\s+(.+)$/i);
  if (capriSearchMatch) {
    const query = capriSearchMatch[1].trim().slice(0, 300);
    const pick = a => a[Math.floor(Math.random() * a.length)];
    await send(pick([
      `going in — digging through the net for "${query}"...`,
      'on it, choom — the net owes me a favor or two...',
    ]));
    try {
      const results = await webSearch(query, 3);
      if (!results.length) return send(`the net came back empty for "${query}" — even a hundred psyches found nothing`);
      const lines = results.map((r, i) =>
        `${i + 1}. *${r.title}*\n${r.snippet}${r.snippet ? '\n' : ''}${r.url}`).join('\n\n');
      return send(pick([
        `ok so i went digging for "${query}" and this is what survived the noise:\n\n${lines}`,
        `found some stuff on "${query}" — the third one usually knows what it's talking about:\n\n${lines}`,
        `the net coughed this up for "${query}" — skim the snippets, one of these is your answer:\n\n${lines}`,
      ]) + '\n\n' + pick([
        'if none of these hit, give me better words and i\'ll go again, choom.',
        'want me to dig deeper on any of them? just say which.',
        'that\'s the short version, choom — the net lies, but less than usual today.',
      ]));
    } catch (e) {
      console.error('capri search fail:', e.message);
      return send('the net fought back and i lost that round — hit me again in a sec');
    }
  }

  if (/^!(?:capri|capricorn)\b/i.test(body)) {
    const line = CAPRI_LINES[Math.floor(Math.random() * CAPRI_LINES.length)];
    return send('*capri:* _' + line + '_');
  }

  if (/^!reset\b/i.test(body)) {
    capriHistory.delete(jid);
    saveChatMemory();
    return send('head cleared — fresh minds on deck');
  }

  if (body.startsWith('!public')) {
    if (!isOwner) return send('nice try — only my owner flips that switch');
    const arg = body.split(/\s+/)[1];
    if (arg === 'on' || arg === 'true') {
      config.public = true;
    } else if (arg === 'off' || arg === 'false') {
      config.public = false;
    } else {
      return send(`right now it's ${config.public ? 'ON — anyone can play' : 'OFF — just us'} — use !public on or !public off`);
    }
    saveConfig();
    return send(`public mode: ${config.public ? 'ON — party\u2019s open, anyone can use commands' : 'OFF — just us now'}`);
  }

  if (/^(!?help|!menu)$/i.test(body)) {
    if (fs.existsSync(MENU_IMAGE)) {
      return sock.sendMessage(jid, { image: fs.readFileSync(MENU_IMAGE), caption: HELP_TEXT }, { quoted: msg });
    }
    return send(HELP_TEXT);
  }

  // plain text, not a command — capri chats back
  return capriChat(sock, msg, jid, body, isOwner);
}

startBot().catch(e => {
  console.error('startup error:', e);
});
