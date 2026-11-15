const { chromium } = require('playwright');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" rx="0" fill="#14171c"/>
<g transform="translate(256 270)">
<polygon points="0,-150 130,-75 0,0 -130,-75" fill="#6fb8ff"/>
<polygon points="-130,-75 0,0 0,150 -130,75" fill="#3b9eff"/>
<polygon points="130,-75 0,0 0,150 130,75" fill="#1f6fc2"/>
<circle cx="0" cy="-75" r="34" fill="#14171c"/>
</g></svg>`;
(async () => {
  const b = await chromium.launch();
  for (const s of [180, 192, 512]) {
    const p = await b.newPage({ viewport: { width: s, height: s } });
    await p.setContent(`<html><body style="margin:0">${svg.replace('<svg ', `<svg width="${s}" height="${s}" `)}</body></html>`);
    await p.screenshot({ path: `docs/icon-${s}.png` });
  }
  await b.close();
})();
