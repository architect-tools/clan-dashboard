// detect-panel.mjs — auto-detect the UI panel as the LARGEST contiguous block of
// "busy" (high edge-density) coarse cells — ignores scattered peripheral game UI.
import sharp from 'sharp';

async function detect(img) {
  const W = 400;
  const meta = await sharp(img).metadata();
  const scale = W / meta.width;
  const H = Math.round(meta.height * scale);
  const { data } = await sharp(img).grayscale().resize(W, H).raw().toBuffer({ resolveWithObject: true });
  const edge = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    edge[i] = Math.abs(data[i + 1] - data[i - 1]) + Math.abs(data[i + W] - data[i - W]);
  }
  // coarse cell grid
  const CELL = 10; const cw = Math.ceil(W / CELL), ch = Math.ceil(H / CELL);
  const dens = new Float32Array(cw * ch);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = Math.floor(y / CELL) * cw + Math.floor(x / CELL);
    if (edge[y * W + x] > 34) dens[c]++;
  }
  const maxd = Math.max(...dens);
  const busy = dens.map((d) => (d > maxd * 0.22 ? 1 : 0));
  // largest 4-connected component of busy cells
  const seen = new Int8Array(cw * ch); let best = null;
  for (let s = 0; s < cw * ch; s++) {
    if (!busy[s] || seen[s]) continue;
    const stack = [s]; seen[s] = 1; const cells = [];
    while (stack.length) {
      const c = stack.pop(); cells.push(c);
      const cx = c % cw, cy = (c / cw) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
        const n = ny * cw + nx;
        if (busy[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
      }
    }
    if (!best || cells.length > best.length) best = cells;
  }
  let minx = cw, miny = ch, maxx = 0, maxy = 0;
  for (const c of best) { const cx = c % cw, cy = (c / cw) | 0; minx = Math.min(minx, cx); miny = Math.min(miny, cy); maxx = Math.max(maxx, cx); maxy = Math.max(maxy, cy); }
  const px = { x: minx * CELL / scale, y: miny * CELL / scale, w: (maxx - minx + 1) * CELL / scale, h: (maxy - miny + 1) * CELL / scale };
  return { ...px, srcW: meta.width, srcH: meta.height };
}

const IMG = process.argv[2], OUT = process.argv[3];
const b = await detect(IMG);
console.log('detected frac:', { x: (b.x / b.srcW).toFixed(3), y: (b.y / b.srcH).toFixed(3), w: (b.w / b.srcW).toFixed(3), h: (b.h / b.srcH).toFixed(3) });
if (OUT) {
  const svg = `<svg width='${b.srcW}' height='${b.srcH}' xmlns='http://www.w3.org/2000/svg'><rect x='${b.x}' y='${b.y}' width='${b.w}' height='${b.h}' fill='none' stroke='lime' stroke-width='4'/></svg>`;
  await sharp(IMG).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).toFile(OUT);
  console.log('saved', OUT);
}
