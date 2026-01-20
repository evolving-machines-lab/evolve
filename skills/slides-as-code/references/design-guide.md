# Slide Design Guide

Design principles for slides that don't look AI-generated.

## Typography System

Three fonts, each with a purpose:

| Font | Use | Weights |
|------|-----|---------|
| Space Grotesk | Titles, UI, labels | 300 (light titles), 500-600 (emphasis) |
| Lora | Body text, explanations | 400 (regular), 600 (strong) |
| JetBrains Mono | Code, technical details | 400-500 |

```css
/* Google Fonts import */
@import url('https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600&family=Space+Grotesk:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');
```

Title styling:
```css
.title {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 52px;
    font-weight: 300;  /* Light weight = sophisticated */
    letter-spacing: -0.02em;  /* Tight tracking */
}
```

## Color System

**Gradient (use sparingly):**
```css
.gradient {
    background: linear-gradient(90deg, #8B5CF6 0%, #EC4899 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
}
```

**Text hierarchy:**
- `#1a1a1a` - Primary headings
- `#333333` - Body text
- `#555555` - Subtle/secondary
- `#888888` - Muted labels
- `#999999` - Disabled/crossed-out

**Surfaces:**
- `#ffffff` - Page background
- `#fafafa` - Light cards
- `#1a1a1a` - Dark cards/code boxes
- `#e5e5e5` - Borders

## Header Philosophy

**Headers should tell the complete story.** The audience should understand the point from the header alone.

Bad (generic):
- "Our Solution"
- "Key Benefits"
- "Architecture Overview"

Good (specific, complete):
- "Same functionality in ~20 lines of code"
- "3x faster builds with zero configuration"
- "From 1,500 lines to 50: the power of abstraction"

## Smart Labels

Use uppercase labels with letter-spacing for context:
```css
.case-label {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 17px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.2em;
    color: #EC4899;
}
```

## Bullet Styles

**Arrow bullets (→)** for features/points:
```css
.bullets li::before {
    content: "→";
    color: #8B5CF6;
}
```

**Checkmarks (✓)** for gains/benefits:
```css
.bullets.gained li::before {
    content: "✓";
    color: #8B5CF6;
}
```

**X marks (✕)** for eliminations/removals:
```css
.bullets.eliminated li::before {
    content: "✕";
    color: #EC4899;
}
```

## Code Boxes

Dark background with syntax highlighting:
```css
.code-box {
    background: #1a1a1a;
    border-radius: 10px;
    padding: 32px 40px;
}
.code {
    font-family: 'JetBrains Mono', monospace;
    font-size: 17px;
    color: #f0f0f0;
    line-height: 1.6;
}
.code .keyword { color: #c792ea; }
.code .string { color: #c3e88d; }
.code .number { color: #f78c6c; }
.code .function { color: #82aaff; }
```

## Capability Cards

For showing features/components:
```css
.capability {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 20px 28px;
    background: rgba(255,255,255,0.08);
    border-radius: 10px;
    border: 1px solid rgba(255,255,255,0.15);
}
```

## Gradient Highlight Box

For CTAs or key takeaways:
```css
.highlight-box {
    display: inline-block;
    padding: 14px 50px;
    background: linear-gradient(90deg, #8B5CF6 0%, #EC4899 100%);
    border-radius: 8px;
}
.highlight-box span {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 20px;
    font-weight: 600;
    color: #ffffff;
}
```

## Visual Connectors

Use symbols to guide flow:
- `+` (purple) - Addition/combination
- `=` (pink) - Result/equals
- `→` (pink) - Transformation
- `↓` (purple) - Flow/output

```css
.connector {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 32px;
    font-weight: 500;
}
.plus { color: #8B5CF6; }
.equals { color: #EC4899; }
```

## What to Avoid (Critical)

**These instantly make slides look AI-generated:**

### BANNED - Emoji Icons
Never use emoji as visual elements:
- 🚀 💡 ✨ 🎯 🔥 ⚡ 🎉 💪 🌟 ❤️
- These scream "AI-generated" or "cheap template"
- If you catch yourself reaching for an emoji, stop and use typography instead

### BANNED - Stock/Clip Art Icons
- No icon libraries (FontAwesome, etc.) as decoration
- No generic illustrations
- No "flat design" icon sets
- If you need visual hierarchy, use typography weight and size

### BANNED - Colored Background Boxes
- No rainbow of colored boxes (red, green, blue, yellow sections)
- No "card per feature" with different colored backgrounds
- Use whitespace and typography to separate sections, not color

### BANNED - Generic Headers
These are lazy and meaningless:
- "Our Solution" → Instead: "Same functionality in ~20 lines"
- "Key Benefits" → Instead: "What's eliminated"
- "How It Works" → Instead: "Code is All You Need"
- "Features" → Instead: List the actual features as the header

### BANNED - Placeholder Content
- No `doSomething()` or `example()` in code
- No "Lorem ipsum"
- No "Your Company Name Here"
- Use real, working code and actual product claims

## Design Inspiration

**Aim for the aesthetic of:**
- Apple keynotes (typography-driven, massive whitespace)
- Linear changelog (clean, monochromatic, precise)
- Vercel marketing (bold type, restrained color)
- Stripe documentation (professional, technical, elegant)

**NOT the aesthetic of:**
- Canva templates
- PowerPoint defaults
- Startup pitch deck templates from Google
- Anything with "professional" clip art

## The Test

Before finalizing any slide, ask:
1. Could this slide be from a free template? → Redesign it
2. Would a professional designer cringe? → Redesign it
3. Does it have any emoji? → Remove them
4. Is the header generic? → Make it specific
