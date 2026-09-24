// WMO weather codes -> Thai wording + a small line icon.

const I = {
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>',
  partly: '<path d="M8.5 3.5v1.6M3.5 8.5h1.6M5 5l1.1 1.1M12 5l-1.1 1.1"/><path d="M11.4 9.3A3.6 3.6 0 1 0 6.2 12"/><path d="M8.5 19.5h9a3.5 3.5 0 0 0 .3-7A5 5 0 0 0 8.2 14a2.8 2.8 0 0 0 .3 5.5Z"/>',
  cloud: '<path d="M7 18.5h10.5a4 4 0 0 0 .4-8A6 6 0 0 0 6.4 12 3.3 3.3 0 0 0 7 18.5Z"/>',
  fog: '<path d="M7 13.5h10.5a4 4 0 0 0 .4-8A6 6 0 0 0 6.4 7 3.3 3.3 0 0 0 7 13.5Z"/><path d="M4 17h16M6 20.5h12"/>',
  drizzle: '<path d="M7 14.5h10.5a4 4 0 0 0 .4-8A6 6 0 0 0 6.4 8 3.3 3.3 0 0 0 7 14.5Z"/><path d="M9 17.5v1M13 17.5v1M17 17.5v1"/>',
  rain: '<path d="M7 13.5h10.5a4 4 0 0 0 .4-8A6 6 0 0 0 6.4 7 3.3 3.3 0 0 0 7 13.5Z"/><path d="M8.5 16.5l-1 3M12.5 16.5l-1 3M16.5 16.5l-1 3"/>',
  storm: '<path d="M7 13.5h10.5a4 4 0 0 0 .4-8A6 6 0 0 0 6.4 7 3.3 3.3 0 0 0 7 13.5Z"/><path d="M12.5 14.5l-2.5 4h3l-2 3.5"/>',
};

const TABLE: [number[], string, keyof typeof I][] = [
  [[0], 'ฟ้าใส', 'sun'],
  [[1], 'แดดเป็นส่วนใหญ่', 'partly'],
  [[2], 'มีเมฆบางส่วน', 'partly'],
  [[3], 'เมฆมาก', 'cloud'],
  [[45, 48], 'มีหมอก', 'fog'],
  [[51, 53, 55, 56, 57], 'ฝนปรอย', 'drizzle'],
  [[61, 80], 'ฝนเล็กน้อย', 'rain'],
  [[63, 81], 'ฝนปานกลาง', 'rain'],
  [[65, 82, 66, 67], 'ฝนหนัก', 'rain'],
  [[71, 73, 75, 77, 85, 86], 'หิมะ', 'cloud'],
  [[95, 96, 99], 'พายุฝนฟ้าคะนอง', 'storm'],
];

export function describe(code: number | null | undefined): { text: string; icon: string } {
  const row = TABLE.find((r) => r[0].includes(code ?? -1));
  const [text, key] = row ? [row[1], row[2]] : ['—', 'cloud' as const];
  return { text, icon: `<svg viewBox="0 0 24 24" class="wx">${I[key]}</svg>` };
}
