// ============================================================
//  generate_icons.js — 執行此腳本以產生必要的 icon PNG 檔案
//  使用方式：node generate_icons.js
// ============================================================

const { createCanvas } = require("canvas");
const fs = require("fs");
const path = require("path");

const sizes = [16, 48, 128];
const iconDir = path.join(__dirname, "icons");

// 確保 icons 資料夾存在
if (!fs.existsSync(iconDir)) {
  fs.mkdirSync(iconDir, { recursive: true });
}

sizes.forEach(size => {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");

  // 背景：深藍色圓角矩形
  const radius = size * 0.2;
  ctx.fillStyle = "#3f51b5";
  ctx.beginPath();
  ctx.moveTo(radius, 0);
  ctx.lineTo(size - radius, 0);
  ctx.quadraticCurveTo(size, 0, size, radius);
  ctx.lineTo(size, size - radius);
  ctx.quadraticCurveTo(size, size, size - radius, size);
  ctx.lineTo(radius, size);
  ctx.quadraticCurveTo(0, size, 0, size - radius);
  ctx.lineTo(0, radius);
  ctx.quadraticCurveTo(0, 0, radius, 0);
  ctx.closePath();
  ctx.fill();

  // 繪製「票」符號
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${Math.floor(size * 0.6)}px serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("🎫", size / 2, size / 2);

  // 儲存
  const buffer = canvas.toBuffer("image/png");
  const outPath = path.join(iconDir, `icon${size}.png`);
  fs.writeFileSync(outPath, buffer);
  console.log(`已產生 ${outPath}`);
});

console.log("所有 icon 已產生完成！");
