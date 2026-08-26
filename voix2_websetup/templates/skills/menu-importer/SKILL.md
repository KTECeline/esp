---
name: "menu-importer"
description: "One-time setup skill that imports a restaurant's menu from its website into Supabase for supabase-ordering to use. Admin-only — a human operator runs this deliberately via /skill menu-importer; it is never triggered by a customer during normal ordering."
user-invocable: true
disable-model-invocation: true
---

# Menu Importer

Reads a restaurant's live menu off its website and writes it into the
same Supabase `menu_items` table that supabase-ordering reads from. Run
this once when setting up a new restaurant on supabase-ordering, or again
whenever the restaurant's menu changes and needs a full refresh — never
during a live customer conversation.

## Connection details

**Keep this base URL identical to the one in
`../supabase-ordering/SKILL.md`** — both skills read and write the same
local database server, and a stale copy here would let this importer and
the live ordering skill silently point at different servers. If you
change one, update the other in the same edit.

- Local DB server base URL: http://localhost:5433

This server only listens on 127.0.0.1 (loopback) and has no auth — no
`apikey`/`Authorization` headers are needed or accepted.

## Steps

1. Ask the person setting up the box for the restaurant's menu URL,
   unless they already gave one in this same request. **Never guess a URL
   or reuse one from a past conversation** — if it's missing, ask and
   wait for the answer before doing anything else.

2. Use the browser tool to navigate to the URL and take a snapshot. Every
   site is laid out differently — do NOT assume the structure, the same
   way food-ordering never assumes a store's layout. If the menu is split
   across categories, tabs, or pages, visit every one of them; a partial
   import is worse than a slower, complete one.

3. Look at the price shown for each item on the listing page:
   - A single clear number — use it as that item's price and move on.
   - A range (e.g. "RM13.00 – RM14.50"), or no price at all (e.g. just
     "Select options" with no RM value) — the real price depends on
     which option the customer picks. **Open that product's own detail
     page** and read the actual price(s) and option choices from there.
     Never guess a price from the listing alone in this case, and never
     skip the item just because the listing alone didn't have enough
     information — only skip it if the detail page is also missing a
     clear price. **Note down the displayed minimum and maximum** (the
     two ends of the listing's range) — you'll need them in step 5 to
     sanity-check the option breakdown you build in step 4.
   - A detail page can expose **more than one independent option group at
     once** (e.g. a cake with separate "Cream", "Berries", and "Candles"
     choices that all apply together) — this is common on WooCommerce
     product pages. Don't assume the first group you see is the only one;
     scroll/read the whole options section before deciding the item only
     has one choice to make.

4. For each item, extract:
   - `name` (string) — the item's name as shown on the site.
   - `price` (number) — strip currency symbols and formatting (e.g. "RM
     15.50" -> `15.50`). If the item's price genuinely varies by option
     (the range/detail-page case from step 3), set this to the item's
     **base price** — the price before any option adjustments — so a
     plain menu listing still shows a sane number, and so `price` plus
     the adjustments below reconstructs the real price of any specific
     combination (see `options`). **If no price can be determined at
     all, even after checking the detail page, skip that item** and note
     it in the final report instead of guessing a number.
   - `description` (string, or `null` if the site doesn't give one).
   - `category` (string, or `null` if the site doesn't group items into
     categories/sections) — the category or section heading the item was
     listed under (e.g. "Cakes", "Beverages").
   - `options` — `null` if the item has no choices to make, otherwise an
     array of **independent option-group objects**, one per group the
     customer must choose from, all of which apply and add together:
     `{"name": "<group label>", "choices": [...]}`. **Every choice is an
     object, never a bare string:** `{"label": "<choice text>",
     "price_adjustment": <number, or omit/null>}`. `price_adjustment` is
     an amount **added to the item's base `price`** when that choice is
     picked — never an absolute replacement price. Only set it on a
     choice that actually costs more or less; for a choice that doesn't
     affect price (e.g. a flavour with no upcharge), omit it (or leave it
     `0`/`null`) so it contributes nothing to the total. A multi-group
     example (three independent groups that all apply at once):
     ```json
     "options": [
       {"name": "Cream", "choices": [
         {"label": "Cream Cheese Frosting", "price_adjustment": 0.30},
         {"label": "Whipped Cream", "price_adjustment": 0.30}
       ]},
       {"name": "Berries", "choices": [
         {"label": "Raspberries"},
         {"label": "Strawberries"}
       ]},
       {"name": "Candles & Cake Topper", "choices": [
         {"label": "No"},
         {"label": "Yes", "price_adjustment": 3.50}
       ]}
     ]
     ```
     Do **not** rename these fields — keep `options`/`choices` exactly as
     above (not `variations`) so this stays consistent with what
     supabase-ordering expects.
   - `available` (boolean) — `true` unless the site marks the item sold
     out or unavailable, in which case `false`.
   - **Do not extract or write `image`.** The site may show a product
     photo, but this is a voice-only ordering flow with no screen for
     menu browsing — drop it, don't invent a column for it.

   **Schema note:** this additive `price_adjustment` shape is a breaking
   change from earlier versions of this skill (an even earlier version
   wrote `choices` as bare strings with no pricing at all; a more recent
   one wrote an absolute `price` per choice, which cannot represent an
   item with more than one price-affecting option group at once). Rows
   written under either old shape should be treated as stale and
   re-imported, not trusted as-is.

5. **Before moving on, sanity-check every item you gave more than one
   option group with a price adjustment.** WooCommerce (and most menu
   sites) don't expose a clean "this exact adjustment applies to this
   exact attribute" mapping — whatever you just inferred in step 4 might
   be wrong. For each such item, check:
   - `price` + (the cheapest `price_adjustment` in each group, summed)
     should roughly equal the listing's displayed **minimum** price.
   - `price` + (the priciest `price_adjustment` in each group, summed)
     should roughly equal the listing's displayed **maximum** price
     (the one you noted in step 3).

   If either side is off by more than rounding, **don't trust the
   decomposition** — go back to the detail page and re-check which
   adjustment belongs to which choice before writing the item, and if you
   still can't make the numbers agree, still import the item (don't
   silently drop real menu data) but flag it clearly in the final report
   as needing a manual re-check, instead of presenting an unverified
   guess as fact.

6. Once every category/tab (and any detail pages opened in step 3) has
   been read, clear the existing menu before writing the new one. This
   Supabase project holds exactly one restaurant's menu, so a full
   refresh is correct here, not a merge. Use exec to run:
   ```
   curl -s -X DELETE "http://localhost:5433/menu_items?id=not.is.null"
   ```

7. Insert every successfully-extracted item in a single request — one
   POST with a JSON array body, not one request per item. Use exec to
   run:
   ```
   curl -s -X POST "http://localhost:5433/menu_items" -H "Content-Type: application/json" -H "Prefer: return=representation" -d '[
     {"name": "...", "price": 0, "description": null, "category": null, "options": null, "available": true},
     {"name": "Red Velvet Cake", "price": 10.30, "description": null, "category": "Cakes", "options": [{"name": "Cream", "choices": [{"label": "Cream Cheese Frosting", "price_adjustment": 0.30}, {"label": "Whipped Cream", "price_adjustment": 0.30}]}, {"name": "Berries", "choices": [{"label": "Raspberries"}, {"label": "Strawberries"}]}, {"name": "Candles & Cake Topper", "choices": [{"label": "No"}, {"label": "Yes", "price_adjustment": 3.50}]}], "available": true}
   ]'
   ```
   `Prefer: return=representation` sends the inserted rows back in the
   response — check that response actually lists the rows before treating
   the import as successful; a short or empty body means it didn't go
   through.

8. **Confirm the write with a follow-up GET** — run the same lookup query
   supabase-ordering uses (`GET http://localhost:5433/menu_items?select=*`)
   and check the new rows are actually there with the expected names, prices,
   and option groups. This is the only thing that proves the import
   actually landed — do not treat the POST response alone, or a locally
   staged file, as sufficient.

9. Report back in plain language: how many items were imported, and —
   for every item that got skipped — its name (or best identifying label)
   and the reason it was skipped (usually a missing or ambiguous price).
   Also list every item flagged in step 5 as needing a manual re-check,
   with the mismatch you found (e.g. "decomposition gives RM13.10–13.80,
   listing shows RM10.30–13.80").

## Rules

- **A local file is never a substitute for finishing this skill.** If you
  stage extracted data in a scratch file along the way, that's fine, but
  it does not count as progress toward "done" — this skill is only
  complete once the DELETE (step 6) and POST (step 7) have actually run
  against Supabase *and* the follow-up GET (step 8) confirms the new rows
  are live. Writing a file and stopping there is an unfinished job, not a
  different way of finishing it.
- **Never invent a price.** If it isn't clearly stated on the listing or
  the item's own detail page, skip the item and report it — don't
  estimate or round to a nearby item's price.
- **Never guess a price from a range or a "Select options"-style
  listing — check the detail page first.** Only skip the item if the
  detail page is also unclear.
- **Every option choice is an object (`{"label": ..., "price_adjustment":
  ...}`), never a bare string, and `price_adjustment` is additive, not an
  absolute price.** It's an amount added to the item's base `price` when
  that choice is picked. Only set it on a choice that genuinely costs
  more or less; otherwise omit it or leave it `0`/`null`. An item can
  have multiple independent option groups that all apply and add
  together (see step 4) — never collapse them into one group just
  because the old schema only supported one.
- **Don't trust an inferred multi-group price decomposition blindly.**
  Sanity-check it against the listing's displayed min/max (step 5) and
  report any item where the numbers don't line up, instead of silently
  writing an unverified guess.
- **Keep `category` when the site provides one; never write `image`.**
  There's no screen-based menu browsing in this ordering flow, so a
  product photo has nowhere to go — extract it or not, it still doesn't
  get written.
- **Never guess or reuse a menu URL from an earlier conversation.** Ask
  for it every time this skill runs, unless it was already given in the
  same request.
- **Only report the import as done after the insert POST actually
  succeeded and the follow-up GET confirms the new rows** — check the
  real responses, the same standard supabase-ordering uses for writing
  orders.
- This is an admin/setup action, not something a customer triggers. It's
  kept out of the model's own skill list (`disable-model-invocation:
  true`) for exactly this reason — it only runs when an operator invokes
  it directly, never as a response to a customer asking about the menu.
- No payment step, no checkout page — this system only records menu
  data, never mention payment.
