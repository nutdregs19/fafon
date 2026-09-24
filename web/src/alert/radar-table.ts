// RainViewer's free radar tiles use one fixed palette ("Universal Blue"): every opaque
// colour stands for exactly one dBZ value. Pure code (no DOM) — the alert server uses it too.
// Table: https://www.rainviewer.com/files/rainviewer_api_colors_table.csv (rain rows, alpha 255)

const UNIVERSAL_BLUE =
  '15:88ddee 16:6cd1eb 17:51c5e8 18:36bae5 19:1baee2 20:00a3e0 21:009ad5 22:0091ca 23:0088bf 24:007fb4 ' +
  '25:0077aa 26:0070a3 27:00699c 28:006295 29:005b8e 30:005588 31:005180 32:004e78 33:004a70 34:004768 ' +
  '35:ffee00 36:ffe000 37:ffd200 38:ffc500 39:ffb700 40:ffaa00 41:ff9f00 42:ff9500 43:ff8b00 44:ff8100 ' +
  '45:ff4400 46:f23600 47:e62800 48:d91b00 49:cd0d00 50:c10000 51:a80000 52:8f0000 53:760000 54:5d0000 ' +
  '55:ffaaff 56:ff9fff 57:ff95ff 58:ff8bff 59:ff81ff 60:ff77ff 61:ff6cff 62:ff62ff 63:ff58ff 64:ff4eff 65:ffffff';

// packed 0xRRGGBB -> dBZ
export const TO_DBZ = new Map<number, number>();
for (const pair of UNIVERSAL_BLUE.split(' ')) {
  const [d, hex] = pair.split(':');
  TO_DBZ.set(parseInt(hex, 16), Number(d));
}

/** dBZ of one RGBA pixel (0 = no rain). Semi-transparent = drizzle/noise below 15 dBZ. */
export const pixelDbz = (r: number, g: number, b: number, a: number) =>
  a === 255 ? TO_DBZ.get((r << 16) | (g << 8) | b) ?? 0 : 0;

/** RGBA pixels of a tile -> dBZ per pixel (0 = no rain). */
export function decodeDbz(px: Uint8ClampedArray | Uint8Array, n: number): Uint8Array {
  const z = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) z[i] = pixelDbz(px[p], px[p + 1], px[p + 2], px[p + 3]);
  return z;
}
