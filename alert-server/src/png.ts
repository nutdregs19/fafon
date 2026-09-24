// Minimal PNG reader for RainViewer radar tiles (8-bit RGBA, not interlaced) -> dBZ per pixel.
// Colours are turned into dBZ only for the pixels asked for: the alert reads a few hundred
// of the 65,536, and the free server plan allows only ~10 ms of work per run.
// Workers have no canvas; the zlib part is done by the runtime's DecompressionStream.
import { pixelDbz } from '../../web/src/alert/radar-table';

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function decodeRadarPng(buf: ArrayBuffer): Promise<(i: number) => number> {
  const b = new Uint8Array(buf), dv = new DataView(buf);
  if (dv.getUint32(0) !== 0x89504e47) throw new Error('not a png');
  let w = 0, h = 0, pos = 8;
  const idat: Uint8Array[] = [];
  while (pos < b.length) {
    const len = dv.getUint32(pos), type = String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]);
    const body = b.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = dv.getUint32(pos + 8); h = dv.getUint32(pos + 12);
      if (body[8] !== 8 || body[9] !== 6 || body[12] !== 0) throw new Error('unexpected png format');
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const joined = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of idat) { joined.set(c, o); o += c.length; }
  const raw = await inflate(joined);

  // undo the per-row filters (bytes per pixel = 4)
  const stride = w * 4, px = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1;
    for (let i = 0; i < stride; i++) {
      const d = y * stride + i, x = raw[src + i], a = i >= 4 ? px[d - 4] : 0;
      const up = y ? px[d - stride] : 0, c = y && i >= 4 ? px[d - stride - 4] : 0;
      let v: number;
      switch (f) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + up; break;
        case 3: v = x + ((a + up) >> 1); break;
        default: { // Paeth
          const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c);
        }
      }
      px[d] = v & 255;
    }
  }
  return (i: number) => { const p = i * 4; return pixelDbz(px[p], px[p + 1], px[p + 2], px[p + 3]); };
}
