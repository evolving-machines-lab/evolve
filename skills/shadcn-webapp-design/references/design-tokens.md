# Design Tokens & Theming

## shadcn/ui Token System

shadcn/ui uses CSS custom properties for theming. These are defined in `globals.css` and consumed via Tailwind.

### Default Token Structure

```css
/* globals.css */
@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 222.2 84% 4.9%;

    --card: 0 0% 100%;
    --card-foreground: 222.2 84% 4.9%;

    --popover: 0 0% 100%;
    --popover-foreground: 222.2 84% 4.9%;

    --primary: 222.2 47.4% 11.2%;
    --primary-foreground: 210 40% 98%;

    --secondary: 210 40% 96.1%;
    --secondary-foreground: 222.2 47.4% 11.2%;

    --muted: 210 40% 96.1%;
    --muted-foreground: 215.4 16.3% 46.9%;

    --accent: 210 40% 96.1%;
    --accent-foreground: 222.2 47.4% 11.2%;

    --destructive: 0 84.2% 60.2%;
    --destructive-foreground: 210 40% 98%;

    --border: 214.3 31.8% 91.4%;
    --input: 214.3 31.8% 91.4%;
    --ring: 222.2 84% 4.9%;

    --radius: 0.5rem;
  }

  .dark {
    --background: 222.2 84% 4.9%;
    --foreground: 210 40% 98%;

    --card: 222.2 84% 4.9%;
    --card-foreground: 210 40% 98%;

    /* ... dark mode overrides */
  }
}
```

### Using Tokens in Tailwind

```tsx
// Background colors
<div className="bg-background" />
<div className="bg-card" />
<div className="bg-muted" />
<div className="bg-primary" />
<div className="bg-secondary" />
<div className="bg-destructive" />
<div className="bg-accent" />

// Text colors
<p className="text-foreground" />
<p className="text-muted-foreground" />
<p className="text-primary-foreground" />

// Borders
<div className="border border-border" />
<div className="border border-input" />

// Focus ring
<button className="focus:ring-ring" />

// Border radius
<div className="rounded-lg" /> // Uses --radius
```

## Custom Theme Example

### Brand Color Integration

```css
/* globals.css - Custom brand colors */
:root {
  /* Brand: Deep teal */
  --primary: 174 62% 25%;
  --primary-foreground: 0 0% 100%;

  /* Accent: Warm coral */
  --accent: 12 76% 61%;
  --accent-foreground: 0 0% 100%;

  /* Refined grays */
  --muted: 220 14% 96%;
  --muted-foreground: 220 9% 46%;

  /* Larger radius for modern feel */
  --radius: 0.75rem;
}
```

### Tailwind Config Extension

```ts
// tailwind.config.ts
import type { Config } from "tailwindcss"

const config: Config = {
  darkMode: ["class"],
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "monospace"],
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
}

export default config
```

## Spacing Scale

Use Tailwind's spacing scale consistently:

```
4   = 1rem  = 16px  (base)
6   = 1.5rem = 24px  (comfortable)
8   = 2rem  = 32px  (sections)
12  = 3rem  = 48px  (major sections)
16  = 4rem  = 64px  (hero)
24  = 6rem  = 96px  (page sections)
```

### Vertical Rhythm

```tsx
// Section spacing
<section className="py-16 md:py-24" />

// Card internal spacing
<Card className="p-6" />

// Form field spacing
<div className="space-y-4" />

// List item spacing
<ul className="space-y-2" />
```

## Typography Scale

```tsx
// Headings
<h1 className="text-4xl font-bold tracking-tight" />
<h2 className="text-3xl font-semibold tracking-tight" />
<h3 className="text-2xl font-semibold" />
<h4 className="text-xl font-semibold" />

// Body
<p className="text-base leading-7" />
<p className="text-sm text-muted-foreground" />

// Small text
<span className="text-xs text-muted-foreground" />

// Display text
<span className="text-5xl md:text-6xl lg:text-7xl font-bold tracking-tighter" />
```

## Color Palette Best Practices

### Do

- Use semantic token names (`primary`, `muted`, `destructive`)
- Keep contrast ratios accessible (4.5:1 for text)
- Use `foreground` variants for text on colored backgrounds
- Define both light and dark mode values

### Don't

- Hard-code hex values in components
- Use arbitrary color values like `text-[#123456]`
- Mix different color systems
- Forget dark mode support

### Quick Palette Check

```tsx
// Accessible text combinations
<div className="bg-primary text-primary-foreground" />
<div className="bg-secondary text-secondary-foreground" />
<div className="bg-muted text-muted-foreground" />
<div className="bg-destructive text-destructive-foreground" />

// Subtle backgrounds
<div className="bg-muted/50" />
<div className="bg-primary/10" />
```
