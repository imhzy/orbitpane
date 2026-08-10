const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const publicDir = path.join(__dirname, 'public');

function iconSvg({ maskable = false } = {}) {
  const background = maskable
    ? '<rect width="512" height="512" fill="#f8fafc"/>'
    : '';
  const panel = maskable
    ? '<rect x="56" y="56" width="400" height="400" rx="104" fill="url(#panel)"/>'
    : '<rect x="32" y="32" width="448" height="448" rx="112" fill="url(#panel)"/>';
  const scale = maskable ? 0.82 : 1;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="panel" x1="96" y1="72" x2="416" y2="448" gradientUnits="userSpaceOnUse">
      <stop stop-color="#ffffff"/>
      <stop offset="1" stop-color="#e2e8f0"/>
    </linearGradient>
  </defs>
${background}
  ${panel}
  <g transform="translate(256 256) scale(${scale}) translate(-256 -256)">
    <circle cx="256" cy="256" r="142" fill="none" stroke="#0f172a" stroke-width="24" stroke-opacity="0.3"/>
    <rect x="188" y="188" width="136" height="136" rx="30" fill="none" stroke="#0f172a" stroke-width="28"/>
    <circle cx="256" cy="256" r="30" fill="#3b82f6"/>
    <circle cx="353" cy="181" r="27" fill="#3b82f6"/>
  </g>
</svg>`;
}

const svgAny = iconSvg();
const svgMaskable = iconSvg({ maskable: true });

async function generate() {
  // 1. Update favicon.svg
  fs.writeFileSync(path.join(publicDir, 'favicon.svg'), svgAny.trim() + '\n');
  console.log('Updated favicon.svg');

  // Helper to generate PNG
  async function makePng(svgText, size, filename) {
    const buf = await sharp(Buffer.from(svgText))
      .resize(size, size)
      .png()
      .toBuffer();
    fs.writeFileSync(path.join(publicDir, filename), buf);
    console.log(`Generated ${filename} (${size}x${size}, ${buf.length} bytes)`);
  }

  await makePng(svgAny, 64, 'pwa-64x64.png');
  await makePng(svgAny, 192, 'pwa-192x192.png');
  await makePng(svgAny, 512, 'pwa-512x512.png');
  await makePng(svgAny, 180, 'apple-touch-icon-180x180.png');
  await makePng(svgMaskable, 512, 'maskable-icon-512x512.png');

  // Simple ICO builder for favicon.ico (wrapping 32x32 & 64x64 PNGs in ICO container)
  const png32 = await sharp(Buffer.from(svgAny)).resize(32, 32).png().toBuffer();
  const png64 = await sharp(Buffer.from(svgAny)).resize(64, 64).png().toBuffer();

  const icoHeader = Buffer.alloc(6);
  icoHeader.writeUInt16LE(0, 0); // Reserved
  icoHeader.writeUInt16LE(1, 2); // Image type (1 = ICO)
  icoHeader.writeUInt16LE(2, 4); // Number of images (2)

  const dir32 = Buffer.alloc(16);
  dir32.writeUInt8(32, 0); // Width
  dir32.writeUInt8(32, 1); // Height
  dir32.writeUInt8(0, 2);  // Colors
  dir32.writeUInt8(0, 3);  // Reserved
  dir32.writeUInt16LE(1, 4); // Color planes
  dir32.writeUInt16LE(32, 6); // Bits per pixel
  dir32.writeUInt32LE(png32.length, 8); // Size
  dir32.writeUInt32LE(6 + 16 + 16, 12); // Offset

  const dir64 = Buffer.alloc(16);
  dir64.writeUInt8(64, 0); // Width
  dir64.writeUInt8(64, 1); // Height
  dir64.writeUInt8(0, 2);  // Colors
  dir64.writeUInt8(0, 3);  // Reserved
  dir64.writeUInt16LE(1, 4); // Color planes
  dir64.writeUInt16LE(32, 6); // Bits per pixel
  dir64.writeUInt32LE(png64.length, 8); // Size
  dir64.writeUInt32LE(6 + 16 + 16 + png32.length, 12); // Offset

  const icoBuf = Buffer.concat([icoHeader, dir32, dir64, png32, png64]);
  fs.writeFileSync(path.join(publicDir, 'favicon.ico'), icoBuf);
  console.log(`Generated favicon.ico (${icoBuf.length} bytes)`);
}

generate().catch(console.error);
