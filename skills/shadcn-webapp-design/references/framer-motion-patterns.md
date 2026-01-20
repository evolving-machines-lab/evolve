# Framer Motion Animation Patterns

## Setup

```tsx
"use client" // Required for App Router

import { motion, AnimatePresence } from "framer-motion"
```

## Entry Animations

### Fade In

```tsx
<motion.div
  initial={{ opacity: 0 }}
  animate={{ opacity: 1 }}
  transition={{ duration: 0.5 }}
>
  Content
</motion.div>
```

### Fade Up

```tsx
<motion.div
  initial={{ opacity: 0, y: 20 }}
  animate={{ opacity: 1, y: 0 }}
  transition={{ duration: 0.5 }}
>
  Content
</motion.div>
```

### Scale In

```tsx
<motion.div
  initial={{ opacity: 0, scale: 0.9 }}
  animate={{ opacity: 1, scale: 1 }}
  transition={{ type: "spring", stiffness: 300, damping: 30 }}
>
  Content
</motion.div>
```

### Slide In

```tsx
<motion.div
  initial={{ opacity: 0, x: -100 }}
  animate={{ opacity: 1, x: 0 }}
  transition={{ type: "spring", stiffness: 100 }}
>
  Slides from left
</motion.div>
```

## Staggered Children

### Container + Item Pattern

```tsx
const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
      delayChildren: 0.2,
    },
  },
}

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { type: "spring", stiffness: 300, damping: 24 },
  },
}

function StaggeredList({ items }) {
  return (
    <motion.ul
      variants={containerVariants}
      initial="hidden"
      animate="visible"
      className="space-y-4"
    >
      {items.map((item) => (
        <motion.li key={item.id} variants={itemVariants}>
          {item.content}
        </motion.li>
      ))}
    </motion.ul>
  )
}
```

### Cards Grid with Stagger

```tsx
function AnimatedCardGrid({ cards }) {
  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={{
        hidden: {},
        visible: { transition: { staggerChildren: 0.08 } },
      }}
      className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"
    >
      {cards.map((card, i) => (
        <motion.div
          key={card.id}
          variants={{
            hidden: { opacity: 0, y: 30, scale: 0.95 },
            visible: {
              opacity: 1,
              y: 0,
              scale: 1,
              transition: { type: "spring", stiffness: 200, damping: 20 },
            },
          }}
        >
          <Card>{card.content}</Card>
        </motion.div>
      ))}
    </motion.div>
  )
}
```

## Hover Interactions

### Button Hover

```tsx
<motion.button
  whileHover={{ scale: 1.02 }}
  whileTap={{ scale: 0.98 }}
  transition={{ type: "spring", stiffness: 400, damping: 17 }}
  className="px-6 py-3 bg-primary text-primary-foreground rounded-lg"
>
  Click me
</motion.button>
```

### Card Hover with Lift

```tsx
<motion.div
  whileHover={{
    y: -8,
    boxShadow: "0 20px 40px -15px rgba(0,0,0,0.2)",
  }}
  transition={{ type: "spring", stiffness: 300, damping: 20 }}
  className="rounded-xl bg-card p-6"
>
  Hover to lift
</motion.div>
```

### Icon Rotation on Hover

```tsx
<motion.div
  whileHover={{ rotate: 180 }}
  transition={{ duration: 0.3 }}
>
  <Settings className="w-6 h-6" />
</motion.div>
```

## Exit Animations

### AnimatePresence for Mounting/Unmounting

```tsx
function Modal({ isOpen, onClose, children }) {
  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/50 z-40"
          />
          {/* Modal */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className="fixed inset-x-4 top-[10%] md:inset-x-auto md:left-1/2 md:-translate-x-1/2 z-50 max-w-lg bg-background rounded-xl p-6"
          >
            {children}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
```

### List Item Removal

```tsx
function AnimatedList({ items, onRemove }) {
  return (
    <AnimatePresence mode="popLayout">
      {items.map((item) => (
        <motion.div
          key={item.id}
          layout
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.8, x: -100 }}
          transition={{ type: "spring", stiffness: 500, damping: 30 }}
        >
          <Card>
            {item.content}
            <Button onClick={() => onRemove(item.id)}>Remove</Button>
          </Card>
        </motion.div>
      ))}
    </AnimatePresence>
  )
}
```

## Scroll Animations

### Animate on Scroll (whileInView)

```tsx
<motion.div
  initial={{ opacity: 0, y: 50 }}
  whileInView={{ opacity: 1, y: 0 }}
  viewport={{ once: true, margin: "-100px" }}
  transition={{ duration: 0.6 }}
>
  Animates when scrolled into view
</motion.div>
```

### Section Reveal

```tsx
function Section({ children, delay = 0 }) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 40 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.3 }}
      transition={{ duration: 0.6, delay }}
      className="py-16"
    >
      {children}
    </motion.section>
  )
}
```

## Page Transitions

### Wrapper Component

```tsx
// components/page-transition.tsx
"use client"

import { motion } from "framer-motion"

export function PageTransition({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
      transition={{ duration: 0.3 }}
    >
      {children}
    </motion.div>
  )
}

// Usage in page.tsx
export default function Page() {
  return (
    <PageTransition>
      <h1>Page content</h1>
    </PageTransition>
  )
}
```

## Reusable Variants

```tsx
// lib/animations.ts
export const fadeIn = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
}

export const fadeUp = {
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 20 },
}

export const scaleIn = {
  initial: { opacity: 0, scale: 0.9 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.9 },
}

export const staggerContainer = {
  animate: {
    transition: {
      staggerChildren: 0.1,
    },
  },
}

export const springTransition = {
  type: "spring",
  stiffness: 300,
  damping: 30,
}

// Usage
<motion.div {...fadeUp} transition={springTransition}>
  Content
</motion.div>
```

## Performance Tips

1. **Use `layout` prop sparingly** - Only when needed for layout animations
2. **Prefer `transform` properties** - `x`, `y`, `scale`, `rotate` are GPU-accelerated
3. **Use `will-change` hint** - For complex animations
4. **Avoid animating `width`/`height`** - Use `scale` instead
5. **Use `AnimatePresence mode="wait"`** - When you need sequential exit/enter
