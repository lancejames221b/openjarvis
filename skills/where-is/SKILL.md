---
name: where-is
description: Store and retrieve the physical location of items using hAIveMind. Triggers on "I put X in Y", "where is X", "where did I put X", "remember X is at Y", and similar natural-language item-location phrases.
tier: FRIDAY
triggers:
  - "I put X in Y"
  - "where is"
  - "where did I put"
  - "remember X is at"
  - "I left X at"
  - "X is in the"
  - "have you seen my"
  - "where are my"
---

# where-is — Item Location Memory

Tell Jarvis where you put things. Ask Jarvis where things are. Never lose anything again.

## Examples

> "Jarvis, I put my passport in the top drawer of the office desk."  
> "Jarvis, where is my passport?"  
> "I left my AirPods on the kitchen counter."  
> "Where did I put the router password card?"  
> "Have you seen my car keys?"

## How It Works

Stores item locations as memories in hAIveMind with a structured format that makes retrieval accurate even if you ask differently than you stored.

**Storing:**
```
store_memory:
  content: "LOCATION [item]: [location] — [timestamp]"
  category: "global"
```

**Retrieving:**
```
search_memories:
  query: "LOCATION [item]"
  limit: 5
```

Returns the most recent location memory for the item.

## Smart Features

- **Updates automatically** — if you put something in a new place, the new location takes precedence
- **Fuzzy matching** — "where's my laptop charger" finds "MacBook Pro charger"
- **Relative time** — "you put it there 3 days ago" gives you confidence context
- **Multiple items** — "where are my chargers?" can surface several related items

## Voice Usage

Works great by voice:

> [walking past the kitchen] "Jarvis, I'm putting my keys on the hook by the door."  
> [later] "Jarvis, where are my keys?"  
> *"You put them on the hook by the door, 4 hours ago."*

## Setup

Requires hAIveMind. See `SETUP.md`.
