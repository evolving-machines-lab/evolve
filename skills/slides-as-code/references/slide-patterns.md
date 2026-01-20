# Slide Patterns

Common slide structures. Mix and match based on content.

## Pattern 1: Title Slide (Centered)

For opening slides, key statements, or single-idea slides.

```
┌─────────────────────────────────────┐
│                                     │
│          [GRADIENT TITLE]           │
│                                     │
│      Subtitle in Lora serif         │
│                                     │
│           → Point one               │
│           → Point two               │
│           → Point three             │
│                                     │
└─────────────────────────────────────┘
```

**When to use:** Opening, closing, big statements

## Pattern 2: Code + Benefits (Two Column)

For showing code alongside explanation.

```
┌─────────────────────────────────────┐
│  CASE LABEL                         │
│  Header tells the complete story    │
├──────────────────┬──────────────────┤
│                  │                  │
│  ┌────────────┐  │  What's gained:  │
│  │            │  │  ✓ Benefit one   │
│  │  CODE BOX  │  │  ✓ Benefit two   │
│  │  (dark)    │  │                  │
│  │            │  │  [GRADIENT BOX]  │
│  └────────────┘  │                  │
│                  │  What's gone:    │
│                  │  ✕ Removed one   │
│                  │  ✕ Removed two   │
└──────────────────┴──────────────────┘
```

**When to use:** Before/after comparisons, code demos

## Pattern 3: Architecture Diagram

For showing system components and relationships.

```
┌─────────────────────────────────────┐
│  [GRADIENT] Core Principles         │
├─────────────────────────────────────┤
│         ┌─────────────────┐         │
│         │   DARK BOX      │         │
│         │  [capabilities] │         │
│         └────────┬────────┘         │
│                  ↓                  │
│         ┌───────────────┐           │
│         │  Output Box   │           │
│         └───────────────┘           │
│                  +                  │
│    ┌─────────┐      ┌─────────┐     │
│    │ Card 1  │      │ Card 2  │     │
│    └─────────┘      └─────────┘     │
│                  =                  │
│         [GRADIENT RESULT BOX]       │
└─────────────────────────────────────┘
```

**When to use:** System overview, how things connect

## Pattern 4: Numbered List

For sequential steps or ranked items.

```
┌─────────────────────────────────────┐
│                                     │
│  [CROSSED] Old Way                  │
│  [GRADIENT] New Way                 │
│                                     │
│      Subtitle explains context      │
│                                     │
│  1.  First major point with         │
│      supporting detail              │
│                                     │
│  2.  Second major point with        │
│      supporting detail              │
│                                     │
│      — closing thought in italic    │
│                                     │
└─────────────────────────────────────┘
```

**When to use:** Conclusions, ordered lists, calls to action

## Pattern 5: Comparison (Transformation)

For showing change/improvement.

```
┌─────────────────────────────────────┐
│  Header: X lines → Y lines          │
├─────────────────────────────────────┤
│                                     │
│  ~260 lines fetch + parsers         │
│                    → "fetch data"   │
│                                     │
│  ~140 lines regex + prompting       │
│                    → "analyze it"   │
│                                     │
│  ~500 lines HTML/CSS/JS             │
│                    → "create UI"    │
│                                     │
└─────────────────────────────────────┘
```

**When to use:** Before/after, complexity reduction

## Slide Selection Guide

| Content Type | Pattern |
|-------------|---------|
| Opening/Closing | Title Slide |
| Code demo | Code + Benefits |
| System overview | Architecture |
| Steps/Process | Numbered List |
| Before/After | Comparison |

## Key Principle

**One idea per slide.** If you have two ideas, make two slides.
