import { decodeRadarPng } from '../src/png';
import { checkSpot, alertText } from '../../web/src/alert/rain-alert';
const url = process.argv[2];
const buf = await (await fetch(url)).arrayBuffer();
let t0 = performance.now();
const z = await decodeRadarPng(buf);
console.log('decode ms', (performance.now() - t0).toFixed(1));
t0 = performance.now(); await decodeRadarPng(buf); console.log('decode2 ms', (performance.now() - t0).toFixed(1));
let wet = 0, sum = 0; for (let i = 0; i < 65536; i++) { const v = z(i); if (v) { wet++; sum += v; } }
console.log('wet', wet, 'sum', sum);
const io = { json: (u: string) => fetch(u).then((r) => r.json()), tile: async (u: string) => decodeRadarPng(await (await fetch(u)).arrayBuffer()) };
for (const [n, la, lo] of [['korat', 14.97, 102.1], ['ubon', 15.24, 104.85], ['cm', 18.79, 98.98]] as const) {
  const a = await checkSpot(la, lo, Date.now(), io); console.log(n, alertText(a).title, JSON.stringify(a));
}
