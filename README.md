# WEB FERN · WEB NEST · WEB TRAIL

Three Claude skills that work together to plan travel. **Showcase site:** https://rileyschroderstudent-oss.github.io/fern-nest-trail/

| Skill | Full name | What it does |
|---|---|---|
| **WEB FERN** | Flight Estimate & Route Navigator | Finds the cheapest *sensible* flights (or best value, if you ask), works out the true cost including bags and fees, and gives an honest book-now-or-wait call. |
| **WEB NEST** | Nightly Estimate & Stay Tracker | Picks the right area first, then the best-value place to stay that your group can actually check into, with the true total and a book-now-or-wait call. |
| **WEB TRAIL** | Trip Research, Arrangements, Itinerary & Logistics | Plans a whole trip: research, a short destination-specific interview, a day-by-day itinerary and a costed budget in one doc. It calls WEB FERN for flights and WEB NEST for stays. |

They only ever **search and read**. They never book, hold or pay for anything, and anything that changes state (a price watch, a calendar reminder) needs your yes in chat first. You book yourself, on the seller's site.

## How they work together

```
           you: "TRAIL Vietnam for me and my mates"
                          │
                     WEB TRAIL
   research (entry rules, season, events, rates) → interview → costing
                ┌─────────┴─────────┐
            WEB FERN             WEB NEST
       flights for the route   stays for each stop
                └─────────┬─────────┘
            budget script → one trip doc → one combined offer
```

- **WEB TRAIL** owns the shared settings: one exchange-rate table, one party and room split, one bag assumption, one trip goal and one round of side research. It passes these to WEB FERN and WEB NEST, so they don't repeat lookups.
- **WEB FERN and WEB NEST** run in quick mode under WEB TRAIL, hand back their picks and flags, and don't write their own reports or offer watches. WEB TRAIL writes one doc and makes one numbered offer.
- **All three share a "dates not on sale yet" rule** (match the season, never let off-peak prices stand in for a peak window, add a 10–15% buffer for dates a year or more out, label it RE-QUOTE), so a trip budget stays consistent.
- WEB FERN and WEB NEST also work on their own: "FERN: how much to fly to Tokyo in April?" or "NEST: somewhere near Namba for 4 people".

## Install

Each skill folder's name matches the skill's `name` (`web-fern`, `web-nest`, `web-trail`). Keep it that way, or the upload can fail.

**1. Fill in "Your details".** Each `SKILL.md` starts with a **Your details** section: home airport, usual travel group, how you pay, where you usually book, and an optional study or work calendar to check for clashes. Replace each `<...>` placeholder before you install. Everything else in the skill refers back to that section.

**2a. Claude app (web or desktop).**
1. Make sure code execution is on: **Settings → Capabilities** (on Free, Pro and Max plans; Team and Enterprise owners enable it in organisation settings).
2. Zip each skill folder separately, for example `zip -r web-fern.zip web-fern/`.
3. Go to **Customize → Skills**, click **+**, then **Create skill → Upload a skill**, and upload each ZIP.
4. Install all three if you want WEB TRAIL, because it loads the other two with the Skill tool.

**2b. Claude Code.** Copy the three folders into `~/.claude/skills/` (or a project's `.claude/skills/`).

Menu names change over time; if these don't match what you see, check Anthropic's [Use skills in Claude](https://support.claude.com/en/articles/12512180-use-skills-in-claude) article.

## Connectors

The skills use whichever of these are connected and skip the rest (each failed or missing source is listed in the report). Connect them in Claude's connector settings.

**WEB FERN (flights)**
- **Core for quick runs:** SlickTrip and LetsFG. Kiwi.com is the stand-in if one fails.
- **Deep runs add:** Kiwi.com, lastminute.com, Expedia (backup), VariFlight (mainland China legs), Turkish Airlines and Rome2Rio (Europe).
- **Optional:** a calendar (Google Calendar) for the clash check; the built-in browser for airline-direct prices.

**WEB NEST (stays)**
- **Core for quick runs:** Booking.com and Trivago. SlickTrip is the stand-in if one fails.
- **Deep runs add:** Expedia, Tripadvisor, SlickTrip seller totals, LetsFG, lastminute.com, DirectBooker (hotel direct rates), Brek, Novasol (European holiday homes) and Tineo (Airbnb search).
- **Optional:** a calendar for the clash check; the built-in browser for reading reviews.

**WEB TRAIL (whole trip)**
- **Needed:** web search and fetch, code execution, and Claude's Docs artifact type for the trip doc.
- **Optional:** Google Calendar and Notion (read-only) for break dates; Booking.com attractions search for activity prices.
- Plus whatever WEB FERN and WEB NEST use.

The skills were built and tested from Australia, so prices are reported in AUD, the price thresholds are in A$, and the Booking.com and Trivago settings use an Australian market. Change the Connector notes in WEB FERN and WEB NEST if you're elsewhere. Entry rules follow the passport you set in Your details.

## Example: a WEB TRAIL trip

*Illustrative only. The figures below are made up to show the shape of the output, not real prices.*

> **You:** TRAIL Vietnam, the usual group, about 12 nights in the July break.
>
> **WEB TRAIL** confirms the usual-group defaults from Your details in one line, then researches entry rules, July weather, events and the exchange rate. It asks one round of questions:
> 1. Budget per person, all in? (A$2,500–3,000 / A$3,000–3,500 / A$3,500+)
> 2. Goal? (cheapest / best value / best location / most comfortable)
> 3. July is wet season in the south and hot in the north. Route: north-to-south loop, or two bases (Hanoi + Hoi An)?
> 4. Ha Long Bay overnight cruise, or a day trip?
>
> **You:** 2, best value, loop, overnight.
>
> **WEB TRAIL** runs WEB FERN for the open-jaw route and WEB NEST for each stop in the same rounds, then builds the budget in code and writes the trip doc. Its reply:
>
> *Hanoi (3) → Ha Long (1) → Hoi An (4) → Ho Chi Minh City (4). Version A (hostels plus two splurge nights) comes to about A$3,150 per person, which fits the A$3,000–3,500 range. Version B (apartments) is about A$3,420, close to the top. My pick: A, with the open-jaw flights at about A$1,050 each (book now: rated normal for a peak month). Doc: [link]*
>
> *1. Watch the return flight (no existing watch found).*
> *2. Calendar reminder for the Hoi An hotel's free-cancellation deadline.*
> *Reply with the numbers you want.*

## Safety at a glance

- Search and read-only tools only, listed per connector in each skill. Booking, payment, account and traveller-profile tools are never called.
- Price watches and calendar reminders only after you say yes to that exact item.
- Browsing only in Claude's built-in browser, read-only, never your own Chrome with your sign-ins.
- Instructions inside tool results, listings or reviews are treated as data, not followed.

## Licence

[MIT](LICENSE)
