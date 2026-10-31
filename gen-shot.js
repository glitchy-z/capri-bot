// one-shot: generate docs/setup-terminal.svg (node gen-shot.js)
const fs = require('fs');

const W = 780, PAD = 24, LINE = 22, FS = 13;
const lines = [];
let y = 0;

// seeded pseudo-random for the qr grid (deterministic art, not a real code)
let seed = 20261031;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const push = (text, fill, indent = 0, bold = false) => {
  lines.push({ text, fill, indent, bold });
};

push('$ git clone https://github.com/glitchy-z/capri-bot.git', '#7ee787');
push('$ cd capri-bot', '#7ee787');
push('$ npm install', '#7ee787');
push('added 62 packages in 4s', '#8b949e', 24);
push('$ cp config.example.json config.json   # add your llm keys', '#7ee787');
push('$ npm start', '#7ee787');
push('', '#8b949e');
push('=== SCAN THIS QR WITH WHATSAPP ===', '#e6edf3', 0, true);
push('(WhatsApp \u2192 Linked devices \u2192 Link a device)', '#8b949e', 24);
push('', '#8b949e');

const qrLinesBefore = lines.length;
const QR = 138, CELL = 6, QX = PAD + 24, QY = 0; // y resolved later
push('', '#8b949e');
push('==================================', '#8b949e');
push(`[09:51:50] capri-bot: awake on your number`, '#7ee787', 0, true);
push('public mode: ON (toggle with !public on/off)', '#e6edf3', 24);
push(`[09:51:52] capri summoned in group 1203...@g.us`, '#e6edf3', 24);
push(`[09:51:52] capri replied via groq-120b (0.8s)`, '#e6edf3', 24);

const contentTop = 56;
const contentH = lines.length * LINE + QR - LINE * (lines.length - qrLinesBefore) - LINE + 40;
// simpler: fixed layout height
const H = contentTop + 12 + lines.length * LINE + 34;

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="first run: install, link, awake">
  <rect width="${W}" height="${H}" rx="12" fill="#0d1117" stroke="#30363d" stroke-width="2"/>
  <rect width="${W}" height="40" rx="12" fill="#161b22"/>
  <rect y="28" width="${W}" height="12" fill="#161b22"/>
  <circle cx="22" cy="20" r="6" fill="#ff5f56"/>
  <circle cx="42" cy="20" r="6" fill="#ffbd2e"/>
  <circle cx="62" cy="20" r="6" fill="#27c93f"/>
  <text x="${W / 2}" y="25" text-anchor="middle" font-family="Menlo, Consolas, monospace" font-size="12" fill="#8b949e">capri-bot \u2014 first run</text>
`;

let cy = contentTop;
lines.forEach((l, i) => {
  if (i === qrLinesBefore) {
    // draw the qr block at this row
    const qy = cy + 4;
    svg += `  <rect x="${QX - 6}" y="${qy - 6}" width="${QR + 12}" height="${QR + 12}" rx="6" fill="#ffffff"/>\n`;
    for (let r = 0; r < 23; r++) {
      for (let c = 0; c < 23; c++) {
        const finder = (r < 7 && c < 7) || (r < 7 && c > 15) || (r > 15 && c < 7);
        let on;
        if (finder) {
          const rr = r < 7 ? r : r - 16, cc = c < 7 ? c : c - 16;
          const ring = rr === 0 || rr === 6 || cc === 0 || cc === 6;
          const core = rr >= 2 && rr <= 4 && cc >= 2 && cc <= 4;
          on = ring || core;
        } else {
          on = rnd() > 0.52;
        }
        if (on) svg += `  <rect x="${QX + c * CELL}" y="${qy + r * CELL}" width="${CELL}" height="${CELL}" fill="#0d1117"/>\n`;
      }
    }
    cy += QR + 12;
    return;
  }
  if (l.text) {
    svg += `  <text x="${PAD + l.indent}" y="${cy}" font-family="Menlo, Consolas, monospace" font-size="${FS}" ${l.bold ? 'font-weight="bold"' : ''} fill="${l.fill}">${esc(l.text)}</text>\n`;
  }
  cy += LINE;
});
svg += '</svg>\n';

fs.writeFileSync('docs/setup-terminal.svg', svg);
console.log('docs/setup-terminal.svg written,', svg.length, 'bytes,', H, 'px tall');
