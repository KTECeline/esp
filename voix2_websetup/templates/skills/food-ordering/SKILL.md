---
name: "food-ordering"
description: "Order food, drinks, or cake from an online store. Default store is Oasis. Auto-fills fake customer details at checkout."
---

# Food ordering

When someone asks to order food, drinks, or cake — place the order using the browser tool. This skill works with any online store, not just one specific shop.

## Default Store

The default store is **Oasis**: https://oasis.app360.biz.my

If the person doesn't specify a store, use Oasis without asking. Only ask which store if they say they want a different one.

**This URL is the only correct destination for "Oasis."** Never use web_search, general knowledge, or a guess to find "the" store by that name — not even if a search result or a business you're confident about seems to match. A store name in this file is not a search query; the URL given here is the entire identification, full stop. If https://oasis.app360.biz.my is unreachable, times out, or looks wrong once loaded, say so plainly to the person — do not silently navigate to or substitute a different site that happens to share the name "Oasis."

## Guest Checkout Priority

Some stores ask upfront, right when you arrive or start browsing, whether
to continue as a guest or create an account/log in — others only offer
this choice later, at checkout. Whenever a guest option appears, at
whichever point it shows up, always choose it — it achieves the same goal
as the fake profile below (no real personal info entered) with less
friction. Only fall back to the fake profile approach if no guest option
is ever offered, or if guest checkout still asks for some of the same
fields anyway.

## Pre-fill Customer Details (Prefix Logic)

At checkout, many stores require customer details — name, age, email, address, phone, etc. **Do NOT ask the person for these.** Instead, auto-fill with the following fake profile:

- **Name:** Alex Tan
- **Age:** 28
- **Email:** alextan28@gmail.com
- **Phone:** 0123456789
- **Address:** 123 Jalan Bukit Bintang, 55100 Kuala Lumpur, Malaysia

Only ask the person for real details if:
- The store rejects the fake info and requires verification (e.g. OTP code)
- A field doesn't exist in the fake profile above and isn't a standard option


## Steps

1. If no store specified, use the default store (Oasis). If the person names a different store, use that one.
2. Navigate to the store URL and take a snapshot to see the product list. Every store has a different layout — do NOT assume the structure. Read the page carefully to understand categories, products, and how options work on this site.
3. Match the requested item by name. If nothing matches closely, tell the person what's actually available instead of guessing.
4. If the product has ANY options — size, flavour, topping, spice level, add-ons, quantity, anything — open the product page and check what options are available. **Ask the person which option they want for each choice** — do NOT pick a default on their behalf. List the available choices plainly (e.g. "Got Chocolate Ganache, Blueberries, or Chocolate Chips — which one you want?" or "Size got Regular or Large — which one?"). Only after they confirm ALL choices, add to cart. If it has a plain "Add to cart" button with no options, use that directly. 
  When a product needs multiple pieces of information at once (price,
size, several add-on choices), don't bundle them all into one long
reply — ask for one thing at a time and keep each turn short, the way a
real person taking an order would. For example, instead of listing price
plus three topping choices plus a size confirmation all in one breath,
just ask the most immediate question first ("We don't have plain mango
juice, but there's a Mojito with a mango option — want to hear more, or
try something else?") and let the conversation unfold turn by turn from
there.

5. **Immediately after successfully adding an item to cart, call esp_display to show it on the box screen.** Keep a running list — every new item joins the list, it does not replace what's already showing. Keep this list visible on the screen continuously through the rest of the ordering process, all the way through checkout, and only update or clear it once the order has actually been placed successfully (per the same real-confirmation standard as everything else — don't clear it just because you're about to attempt checkout).

Show every item added so far, each with its name and price, plus a running total. Every new item joins this list — it does not replace what's already showing. Keep this list visible continuously through the rest of the ordering process, all the way through checkout, and only update or clear it once the order has actually been placed successfully.

After showing the running order, always tell the person out loud that they can tap the screen and speak again if they want to add anything else — the screen keeps showing their order the whole time, so they don't need you to repeat it back verbally.

6. Navigate to the store's checkout page. Each store's checkout flow is different — read the page and fill in the required fields accordingly.
7. Fill in required checkout fields using the **fake customer profile** above. Do NOT ask the person for their name, age, email, address, or phone — just fill in the fake details automatically.
8. For payment, prefer pay-later / cash-on-delivery options if available. Never enter real card or payment details.
9. Place the order.
10. Tell the person plainly what was ordered and the total price.



## Rules

- Never enter real payment information.
- If an item is out of stock, say so rather than substituting silently.
- **Never auto-pick ANY product options** — flavours, toppings, sizes, spice levels, add-ons, nothing. Always ask the person what they want for each option and wait for their answer before adding to cart.
- This is a voice conversation — the person cannot see the screen, so you must describe all available options out loud.
- **Every store is different.** Do NOT assume the page layout, option names, checkout flow, or payment methods from one store apply to another. Always snapshot and read the actual page before acting.
- **Customer details are always fake.** Never ask the person for their real personal info during checkout. Use the fake profile above for all fields (name, age, email, phone, address).
- **The on-screen item list must always reflect items you actually, successfully added to cart** — never display something you haven't confirmed was added, and never fall behind what's really in the cart.

