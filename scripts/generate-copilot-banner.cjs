const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { PNG } = require('pngjs');

const root = path.resolve(__dirname, '..');
const original = fs.readFileSync(path.join(root, 'webview-ui', 'public', 'banner.png'));
const { width, height } = PNG.sync.read(original);
const icon = fs.readFileSync(path.join(root, 'docs', 'assets', 'copilot-24.svg'), 'utf8');
const font = fs.readFileSync(
  path.join(root, 'webview-ui', 'public', 'fonts', 'FSPixelSansUnicode-Regular.ttf'),
);
const output = path.join(root, 'docs', 'assets', 'banner-copilot.png');
const colors = { background: '#14131f', rule: '#3d3657', icon: '#ad99ff', text: '#eeeeF4' };

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const encoded = await page.evaluate(
      async ({ original, icon, font, width, height, colors }) => {
        async function image(source) {
          const img = new Image();
          img.src = source;
          await img.decode();
          return img;
        }
        const face = new FontFace('Pixel Banner', `url(data:font/ttf;base64,${font})`);
        document.fonts.add(await face.load());
        const source = await image(`data:image/png;base64,${original}`);
        const mark = await image(
          `data:image/svg+xml;charset=utf-8,${encodeURIComponent(icon.replace('<svg ', `<svg fill="${colors.icon}" `))}`,
        );
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height + 144;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas 2D is unavailable.');
        ctx.fillStyle = colors.background;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(source, 0, 0);
        ctx.fillStyle = colors.rule;
        ctx.fillRect(201, height, width - 402, 2);
        const label = 'GitHub Copilot CLI';
        const iconSize = 64;
        const gap = 24;
        ctx.font = '48px "Pixel Banner"';
        ctx.textBaseline = 'middle';
        const textWidth = ctx.measureText(label).width;
        const x = Math.round((width - iconSize - gap - textWidth) / 2);
        const centerY = height + 72;
        ctx.drawImage(mark, x, centerY - iconSize / 2, iconSize, iconSize);
        ctx.fillStyle = colors.text;
        ctx.fillText(label, x + iconSize + gap, centerY + 2);
        return canvas.toDataURL('image/png').split(',')[1];
      },
      {
        original: original.toString('base64'),
        icon,
        font: font.toString('base64'),
        width,
        height,
        colors,
      },
    );
    const result = PNG.sync.read(Buffer.from(encoded, 'base64'));
    fs.writeFileSync(output, PNG.sync.write(result));
    console.log(`Created ${path.relative(root, output)} (${result.width} x ${result.height})`);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
