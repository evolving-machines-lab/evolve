#!/usr/bin/env node
const pptxgen = require('pptxgenjs');
const path = require('path');
const fs = require('fs');

const exportsDir = process.argv[2] || './html/exports';
const outputFile = process.argv[3] || 'presentation.pptx';

// Find all slideN.png files and sort numerically
const slides = fs.readdirSync(exportsDir)
  .filter(f => /^slide\d+\.png$/.test(f))
  .sort((a, b) => {
    const numA = parseInt(a.match(/\d+/)[0]);
    const numB = parseInt(b.match(/\d+/)[0]);
    return numA - numB;
  });

if (slides.length === 0) {
  console.error(`No slide PNGs found in ${exportsDir}`);
  console.error('Run export-slides.js first to generate PNGs');
  process.exit(1);
}

console.log(`Found ${slides.length} slides`);

const pptx = new pptxgen();

// Set 16:9 aspect ratio (matches 1920x1080)
pptx.defineLayout({ name: 'CUSTOM', width: 10, height: 5.625 });
pptx.layout = 'CUSTOM';

for (const slideFile of slides) {
  const slidePath = path.join(exportsDir, slideFile);
  console.log(`Adding ${slideFile}`);

  const slide = pptx.addSlide();
  slide.addImage({
    path: slidePath,
    x: 0,
    y: 0,
    w: '100%',
    h: '100%',
  });
}

pptx.writeFile({ fileName: outputFile })
  .then(() => {
    console.log(`Created ${outputFile} with ${slides.length} slides`);
  })
  .catch(err => {
    console.error('Error creating PPTX:', err);
    process.exit(1);
  });
