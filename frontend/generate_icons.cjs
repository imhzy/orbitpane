const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const publicDir = path.join(__dirname, 'public');

const svgAny = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" fill="#09090b"/>
  <circle cx="256" cy="256" r="165" fill="none" stroke="#27272a" stroke-width="16"/>
  <circle cx="256" cy="256" r="165" fill="none" stroke="#2563eb" stroke-width="16" stroke-dasharray="130 370" stroke-linecap="round"/>
  <rect x="171" y="171" width="170" height="170" rx="36" fill="#121215" stroke="#3b82f6" stroke-width="18"/>
  <circle cx="256" cy="256" r="32" fill="#3b82f6"/>
  <circle cx="372" cy="140" r="28" fill="#3b82f6"/>
</svg>`;

const svgMaskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" fill="#09090b"/>
  <g transform="translate(256 256) scale(0.78) translate(-256 -256)">
    <circle cx="256" cy="256" r="165" fill="none" stroke="#27272a" stroke-width="16"/>
    <circle cx="256" cy="256" r="165" fill="none" stroke="#2563eb" stroke-width="16" stroke-dasharray="130 370" stroke-linecap="round"/>
    <rect x="171" y="171" width="170" height="170" rx="36" fill="#121215" stroke="#3b82f6" stroke-width="18"/>
    <circle cx="256" cy="256" r="32" fill="#3b82f6"/>
    <circle cx="372" cy="140" r="28" fill="#3b82f6"/>
  </g>
</svg>`;

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
