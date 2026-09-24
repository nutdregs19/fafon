# ฟ้าฝน — แอปพยากรณ์อากาศส่วนตัว (แบบ Windy)

ของใช้ส่วนตัวของเจ้าของ ไม่ใช่งานลูกค้า · PWA ชุดเดียวใช้ทั้ง iPhone/Android/เว็บ · ฟรีทั้งหมด
แผนเต็มที่ตกลงกันไว้: `C:\Users\User\.claude\plans\api-ios-sorted-dewdrop.md`

## โครงสร้าง
- `pipeline/` Python — ดึง ECMWF + GFS → ตัดภูมิภาค (lat −5..30, lon 88..122, 0.25°) → PNG ละ 1 ช่วงเวลา + `manifest.json`
  - PNG = ตัวเลขในสีพิกเซล: ครึ่งบน R=u G=v B=temp · ครึ่งล่าง R=ฝน(sqrt) G=เมฆ · ช่วงค่าอยู่ใน `common.py ENC` ต้องตรงกับ `web/src/data/store.ts`
  - รันเอง: `cd pipeline && .venv/Scripts/python.exe render.py` (ดึงเต็ม ~4 นาที ~13 MB) · ทดสอบเร็ว `--max-steps 4 --out ../_test_data`
- `web/` Vite + TS + MapLibre GL v6 — ชั้นสีวาดด้วย CPU ลง canvas (Mercator) แล้วส่งเป็น canvas source · เส้นลมเป็น canvas 2D ซ้อนบน
- `.github/workflows/update.yml` — ทุก 6 ชม. รัน pipeline → build → GitHub Pages
- พรีวิว: `fafon-weather` (dev, 4800) · `fafon-weather-build` (build จริง, 4801) ใน `D:\virtual tour\.claude\launch.json`

## กับดักที่เจอแล้ว
- **eccodes ไม่ปลอดภัยกับหลายเธรด** ("fatal flex scanner") → ดาวน์โหลดพร้อมกันได้ แต่ถอด GRIB ในเธรดหลักเท่านั้น
- **ECMWF บน AWS ตอบ SlowDown** ถ้ายิงถี่ → ใช้ Google mirror เป็นหลัก (`storage.googleapis.com/ecmwf-open-data`) · ไม่ใช้ไลบรารี `ecmwf-opendata` แล้ว (ค้างเงียบ)
- ECMWF รอบ 06/18z ไปแค่ 144 ชม. → ใช้รอบ 00/12z เท่านั้น
- GFS: ฝนใช้ `APCP 0-N hour acc` (สะสมจากต้น) ลบกันเป็นรายชั่วโมง · เมฆใช้ TCDC แบบ "N hour fcst" ไม่ใช่ "ave"
- **MapLibre v6 ต้องตั้ง worker เอง**: `import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'` + `setWorkerUrl` + `worker.format: 'es'` ใน vite config
- เริ่มแอปที่ `style.load` ไม่ใช่ `load` (รอแผนที่พื้นหลังครบช้ามาก)
- canvas source ต้อง `play()` → render หนึ่งเฟรม → `pause()` ทุกครั้งที่วาดใหม่ ไม่งั้นภาพไม่อัปเดต
- launch.json ห้ามพิมพ์พาธ `D:\2609...` ใน node -e (`\260` กลายเป็น °) และตัวพรีวิวไม่รับ `cwd` นอก `D:\virtual tour` → ใช้ `npm --prefix`
- หน้าต่างพรีวิวถูกซ่อน = requestAnimationFrame ไม่วิ่ง วัด fps ไม่ได้
- ลบไฟล์ไม่ได้ (กฎกลาง) → `web/public/data` สะสมรอบเก่าบนเครื่อง ไม่กระทบเว็บจริงเพราะ CI เริ่มจากโฟลเดอร์ว่าง

## หน้าตาแบบ Windy (เจ้าของส่งภาพ Windy มาเทียบ 24 ก.ย. 2569)
- ชั้นฝน: พื้นเทากลาง `#858585` บก/ทะเลเกือบเท่ากัน (`setTheme('grey')` ใน main.ts) · ชั้นอื่นพื้นเข้ม · ชื่อเมืองขาวขอบดำทุกโหมด
- สีฝน = สีเรดาร์ Windy ตามค่า dBZ (วัดจากภาพจริง) แปลง มม./ชม. ด้วย Marshall-Palmer ใน `palettes.ts` — **เรดาร์กับพยากรณ์ใช้สเกลเดียวกัน**
- ขยายภาพด้วย bicubic (ไม่ใช้ blur) ขอบก้อนฝนถึงจะคม
- เรดาร์ RainViewer ฟรีมีชุดสีเดียว (Universal Blue) ทุก scheme ได้ภาพเหมือนกัน → ขอแบบ `0_0` (ไม่ smooth) แล้วถอดสีกลับเป็น dBZ ผ่าน `addProtocol('rvc')` ใน `radar-colors.ts` · ห้ามใช้ median ธรรมดา (ซูมไกลฝนเป็นจุดกระจาย ถูกลบหมด)
- ดาวเทียม GIBS เป็นสีรุ้ง + ถูก resample (5 หมื่นสี) ถอดเป๊ะไม่ได้ → ประมาณความเย็นจาก hue แล้ววาดเมฆขาวบนพื้นเข้ม (`sat-colors.ts`) · ยอดพายุที่เย็นสุดกลับเป็นเทา/ดำกลางวงแดง ต้อง flood-fill จากสีแดง (จำกัดระยะ)
- เส้นลมโชว์**เฉพาะชั้นลม** — เจ้าของสั่งให้แต่ละชั้นแยกกันชัด ๆ (ฝน/เมฆ/อุณหภูมิ ไม่มีเส้นลม)
- แถบเวลา = เข็มนิ่งกลางแถบ รูดตัวแถบ (ทีละนาที) · ปุ่มเล่น 1 ชม./0.3 วิ
- **ชื่อคลาส CSS ชนกันง่าย**: `.day` ของการ์ดรายวันเคยไปทับขีดเที่ยงคืนของแถบเวลา

## ECMWF 9 กม. (เจ้าของเลือกอัปเกรด 24 ก.ย. 2569)
- แหล่ง: Open-Meteo open data `openmeteo.s3.us-west-2.amazonaws.com/data_run/ecmwf_ifs/<ปี/เดือน/วัน>/<HHMM>Z/<ตัวแปร>.om` + `meta.json` (valid_times) · ไฟล์ละ 300–700 MB ทั้งโลก
- ตาราง O1280 reduced Gaussian (1 มิติ เหนือ→ใต้ ทีละวง เริ่มลองจิจูด 0) → `fetch_ecmwf9.py` อ่านแค่แถบละติจูดไทยเป็นก้อน 8 MB แล้วแปลงเป็น 0.1° (341×351)
- **ฝนในไฟล์ช่อง k = ยอดของช่วง k→k+1** (ตรวจกับ `single-runs-api.open-meteo.com?run=`) → เฟรม k ใช้ p[k-1]
- จำนวนช่วงเวลาในไฟล์อาจน้อยกว่า meta.json ชั่วคราวระหว่างเขาเขียนต่อท้าย → ใช้ค่าน้อยกว่า
- ตรวจแล้วตรงกับ API รอบเดียวกัน: อุณหภูมิ ±0.1°C · ลม m/s · เมฆ % ตรงทุกค่า
- **เน็ตเครื่องนี้ไป us-west-2 ช้า (~40 KB/s)** โหลดชุดเต็มบนเครื่องไม่ได้ → รันจริงบน GitHub เท่านั้น · ถ้าพัง `render.py` ถอยไป 25 กม. เอง
- ชื่อไฟล์ภาพมีขนาดตาราง (`_100_` / `_250_`) กันแคชในมือถือหยิบไฟล์ผิดความละเอียด
- ฝั่งเว็บ: แต่ละแหล่งมี `grid` ของตัวเอง · เก็บภาพดิบในหน่วยความจำแค่ 48 เฟรม โหลดล่วงหน้า 36 เฟรมรอบเวลาที่ดู

## ยังไม่ทำ (รอบหน้า)
แจ้งเตือนฝน · เรดาร์กรมอุตุฯ · ขึ้น App Store
