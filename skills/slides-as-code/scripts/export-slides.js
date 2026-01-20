#!/usr/bin/env node
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

// Auto-detect slides by scanning the html directory
const htmlDir = process.argv[2] || '.';
const exportDir = path.join(htmlDir, 'exports');

// Find all slideN.html files and sort numerically
const slides = fs.readdirSync(htmlDir)
  .filter(f => /^slide\d+\.html$/.test(f))
  .sort((a, b) => {
    const numA = parseInt(a.match(/\d+/)[0]);
    const numB = parseInt(b.match(/\d+/)[0]);
    return numA - numB;
  });

if (slides.length === 0) {
  console.error('No slide files found (expected slide1.html, slide2.html, etc.)');
  process.exit(1);
}

console.log(`Found ${slides.length} slides: ${slides.join(', ')}`);

// Ensure exports directory exists
if (!fs.existsSync(exportDir)) {
  fs.mkdirSync(exportDir, { recursive: true });
}

async function exportSlides() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  for (const slide of slides) {
    const slideNum = slide.match(/\d+/)[0];
    const slidePath = path.resolve(htmlDir, slide);
    const exportPath = path.join(exportDir, `slide${slideNum}.png`);

    console.log(`Exporting ${slide} -> exports/slide${slideNum}.png`);

    await page.goto(`file://${slidePath}`);
    await page.waitForTimeout(800);
    await page.screenshot({ path: exportPath, type: 'png' });
  }

  await browser.close();
  console.log(`Done! ${slides.length} screenshots saved to ${exportDir}/`);
}

exportSlides().catch(console.error);
