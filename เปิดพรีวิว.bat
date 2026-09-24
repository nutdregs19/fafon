@echo off
chcp 65001 >nul
title Fafon preview
cd /d "%~dp0web"
where npm >nul 2>nul || (echo ไม่พบ Node.js - ติดตั้งจาก nodejs.org ก่อน & pause & exit /b 1)
if not exist node_modules (
  echo ติดตั้งส่วนประกอบครั้งแรก รอสักครู่...
  call npm install
)
echo.
echo  กำลังเปิดแอป "ฟ้าฝน" ในเบราว์เซอร์...
echo  - เปิดบนคอม:  http://localhost:5180
echo  - เปิดบนมือถือ (ใช้ Wi-Fi เดียวกัน): ดูบรรทัด Network ด้านล่าง
echo  - เลิกใช้ ปิดหน้าต่างดำนี้ได้เลย
echo.
call npm run dev -- --port 5180 --open
pause
