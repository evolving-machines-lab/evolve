#!/bin/bash
# Initialize a new slides-as-code project

set -e

PROJECT_NAME="${1:-slides}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSETS_DIR="$(dirname "$SCRIPT_DIR")/assets"

echo "Creating slides project: $PROJECT_NAME"

mkdir -p "$PROJECT_NAME/html/exports"

# Copy viewer
cp "$ASSETS_DIR/viewer.html" "$PROJECT_NAME/html/"

# Copy template as slide1
cp "$ASSETS_DIR/template-slide.html" "$PROJECT_NAME/html/slide1.html"

# Create package.json
cat > "$PROJECT_NAME/package.json" << 'EOF'
{
  "name": "slides",
  "scripts": {
    "export": "node export-slides.js html",
    "pptx": "node create-pptx.js html/exports presentation.pptx",
    "build": "npm run export && npm run pptx"
  },
  "dependencies": {
    "playwright": "^1.57.0",
    "pptxgenjs": "^4.0.1"
  }
}
EOF

# Copy scripts
cp "$SCRIPT_DIR/export-slides.js" "$PROJECT_NAME/"
cp "$SCRIPT_DIR/create-pptx.js" "$PROJECT_NAME/"

echo ""
echo "Project created at: $PROJECT_NAME/"
echo ""
echo "Installing dependencies..."
cd "$PROJECT_NAME"
npm install --silent
npx playwright install chromium

echo ""
echo "Ready! Edit slides:"
echo "  html/slide1.html (edit)"
echo "  html/slide2.html, slide3.html, etc. (create)"
echo "  html/viewer.html (update slides array)"
echo ""
echo "Preview:  open html/viewer.html"
echo ""
echo "Export:"
echo "  npm run export    # HTML → PNG"
echo "  npm run pptx      # PNG → PPTX"
echo "  npm run build     # Full pipeline"
