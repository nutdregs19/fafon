// Build a push message with the library, then decrypt it the way a phone would (RFC 8291).
import { buildPushPayload } from '@block65/webcrypto-web-push';
import { createECDH, createHmac, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const jwk = JSON.parse(readFileSync('.dev.vars', 'utf8').match(/'(.*)'/)![1]);
const ua = createECDH('prime256v1'); ua.generateKeys();
const auth = randomBytes(16);
const b64 = (b: Buffer) => b.toString('base64url');
const sub = { endpoint: 'https://web.push.apple.com/QTest', keys: { p256dh: b64(ua.getPublicKey()), auth: b64(auth) } };
const pub = b64(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]));
const pl: any = await buildPushPayload({ data: { title: 'ทดสอบ', body: 'ฝนจะมา' }, options: { ttl: 1800, urgency: 'high', topic: 'rain-gps' } },
  { endpoint: sub.endpoint, expirationTime: null, keys: sub.keys }, { subject: 'https://nutdregs19.github.io/fafon/', publicKey: pub, privateKey: jwk.d });
const headers = pl.headers, body = pl.body;
console.log('headers', Object.entries(headers).map(([k, v]: any) => k + '=' + (k === 'authorization' ? String(v).slice(0, 14) + '…' : v)).join(' | '));
const buf = Buffer.from(body instanceof ArrayBuffer ? body : (body as any).buffer ? Buffer.from((body as any).buffer, (body as any).byteOffset, (body as any).byteLength) : body as any);
console.log("head", buf.subarray(0, 24).toString("hex"));
const salt = buf.subarray(0, 16), idlen = buf[20], keyid = buf.subarray(21, 21 + idlen), ct = buf.subarray(21 + idlen);
const hk = (salt: Buffer, ikm: Buffer, info: Buffer, len: number) => {
  const prk = createHmac('sha256', salt).update(ikm).digest();
  return createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, len);
};
const shared = ua.computeSecret(keyid);
const ikm = hk(auth, shared, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), keyid]), 32);
const cek = hk(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
const nonce = hk(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
const d = createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(ct.subarray(ct.length - 16));
const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
console.log('decrypted:', pt.subarray(0, pt.lastIndexOf(2)).toString('utf8'));
const jwt = String(headers.authorization).split(",")[0];
const claims = JSON.parse(Buffer.from(String(jwt).split(' ')[1].replace('t=', '').split('.')[1], 'base64url').toString());
console.log('jwt claims', claims);
