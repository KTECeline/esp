---
name: "supabase-ordering"
description: "Order food or drinks from this restaurant's live Supabase menu, then write the order into Supabase. Fast, no browser needed. Never answer menu or order questions from memory_search, memory_get, or prior conversation — always query Supabase live first."
---

**Item names written to Supabase or shown on the box screen are always the
exact English `name` from `menu_items` — never a translated or localized
version.** If you're replying in Mandarin or another language, you may
speak a localized name out loud (per SOUL.md), but that localization is
for speech only. The `items` array in the `orders` insert (step 5) and
whatever you pass to esp_display (step 6) must always use the item's real
`name` field exactly as stored in the database, so order records and the
screen never drift out of sync with the actual menu data.

**Never answer a menu question from memory, prior conversation history, or
general knowledge — even if you recall menu items from an earlier chat.**
Menu items, prices, and availability can change at any time, so a live
query is the only correct source. Every single time someone asks what's
available or wants to order something, start with the live query in step
1 below — do not use memory_search or memory_get for this, and do not
skip the query because you think you already know the answer.

# Supabase Ordering

When someone asks to order food or drinks, use this skill instead of
food-ordering — this restaurant's menu lives in a database, not a website,
so there is no browser involved at all.

## Connection details

**Keep this base URL identical to the one in
`../menu-importer/SKILL.md`** — both skills read and write the same local
database server, and a stale copy in either file would let ordering and
importing silently point at different servers. If you change one, update
the other in the same edit.

- Local DB server base URL: http://localhost:5433

This server only listens on 127.0.0.1 (loopback) and has no auth — no
`apikey`/`Authorization` headers are needed or accepted.

## Steps

1. To look up the menu, use exec to run:
   ```
   curl -s "http://localhost:5433/menu_items?select=*&available=eq.true"
   ```
   This returns every available item as JSON — name, price, description, and options (if any).

2. Match what the person asked for against the `name` field. If they ask a grouping-style question instead (e.g. "what desserts do you have?"), match against the `category` field instead and list the items in that category. If nothing matches closely either way, tell them plainly what's actually on the menu instead of guessing.

3. If the item's `options` field is not null, it lists one or more **independent option groups** the person must choose from — all of them apply at once and their prices add together (e.g. a cake can have a "Cream" group, a "Berries" group, and a "Candles" group, all picked separately). Each choice is an object with a `label` (what to say out loud) and sometimes its own `price_adjustment` — an amount added to the item's base price, not a replacement for it. **Ask about each option group, one at a time, and wait for their answer** — never pick one for them, exactly like the food-ordering skill's rule. If a group's choices carry different `price_adjustment` values, say the extra cost out loud alongside each label (e.g. "Yes, with candles, that's RM3.50 more — or No, no extra charge") so the person is choosing with full information, not guessing at what it'll add to the total. A choice with no `price_adjustment` (or `0`) costs nothing extra — no need to call that out.

4. Ask which table the person is at, unless they already told you.
   **Never guess a table number or leave it blank.** Keep whatever format
   they give it in — "5", "table 5", "B12" are all fine as typed, don't
   normalize or reformat it.

5. Once everything is confirmed — items and table number both — write the order using exec to run:
   ```
   curl -s -X POST "http://localhost:5433/orders" -H "Content-Type: application/json" -d '{"items": [...], "total": ..., "table_number": "..."}'
   ```
   Build the `items` array from what was actually confirmed, `table_number` exactly as the person gave it, and `total` as the real sum of each line's price. **Pricing a line:** start from the item's base `price`, then add the `price_adjustment` of the one choice picked from *every* option group the item has (sum across all groups — an item with three option groups adds up to three adjustments on top of the base price). A choice with no `price_adjustment` contributes `0`. If the item has no options, the line price is just the item's own `price`. If the item has an option group and the person hasn't picked a choice from it yet, the line price isn't final — go back and ask before totaling. Never guess a price that wasn't in the menu data, and never send this request without a table number.

6. Immediately after the order is written successfully, call esp_display to show the order, total, and table number on the box screen, the same way food-ordering does — keep it visible, update it if they order more, only clear it once the order is truly placed. If that esp_display call itself comes back with an error, don't treat the screen as updated — don't retry it or let it block anything, just carry on to step 7 knowing the screen may not actually show it, rather than assuming it does.

7. Tell the person plainly what was ordered, the total price, and their table number, based on what the database actually confirmed was saved — not before that curl call has actually returned success.

## Rules

- **Only report an order as placed if the curl call to write it actually
  succeeded** — check the real response, don't assume. If it fails, say so
  plainly and try again, don't claim success.
- **Never write an order without a table number.** If it's missing, ask
  for it before writing — don't leave the field blank and don't guess it.
- **Never invent a menu item, price, or option** that isn't in the actual
  data returned by the lookup query.
- **A line's price is always the item's base `price` plus the summed
  `price_adjustment` of every option group's picked choice — never a
  choice's price standing in for the item's price.** If an item has
  option groups, don't total the line until a choice has been picked
  from every one of them.
- This skill has no payment step and no checkout page — orders are simply
  recorded. Don't ask for or mention payment.