# Cash Flow Planner — project reference

A personal cash-flow and net-worth planner: a daily bank balance from **2026-08-14** out to a
chosen horizon (5, 15 or 30 years), built around the OKC home bought Sept 18, 2026 and the
Midland home that is now let and may be sold. The owner reconciles real balances against it.

This file describes the app **as it is now**. The design history (why each rule exists) lives
in git log and in the `⚠️` comments beside the code; read those before changing a rule.

---

## 1. Stack & files

Zero npm dependencies. Pure Node (`node:http` + `node:sqlite`), vanilla JS, hand-drawn SVG.
No build step.

```
server.js            HTTP server, reconcile API, static files
package.json         "start": "node server.js"; engines node >= 22
README.md            deploy + reconcile rules (user-facing)
public/index.html    THE APP — styles, markup, model, renderer, reconcile UI, all inline
public/manifest.json PWA manifest (theme/background = page colour #f7f7f5)
public/icon.svg      the icon (rising line on #2f6fec); icon-512/192, apple-touch-icon (180),
                     favicon-32 are rendered from it — and the three <link rel=icon> in the
                     <head> embed the same images as data URLs
```

## 2. Deploy (Railway)

| Env var | Value | Notes |
|---|---|---|
| `RECONCILE_PASSCODE` | the PIN | Required to save; unset ⇒ read-only |
| `DATA_DIR` | `/data` | Must match the volume mount |
| `RECONCILE_UNLOCK_HOUR` | `19` | Hour (America/Chicago) today unlocks |
| `PORT` | — | Railway sets it |

A volume at `/data` is mandatory or reconciliations vanish on redeploy. Health check:
`GET /api/state` → `"saveEnabled": true`, `"storage": "sqlite"` (`"json"` means Node < 22).

## 3. Server API (`server.js`)

| Route | Method | Purpose |
|---|---|---|
| `/api/state` | GET | today, hour, unlockHour, range, saveEnabled, storage, all reconciles + edit log |
| `/api/verify` | POST | `{passcode}` → 200 or 401; gates the PIN screen |
| `/api/reconciles` | POST | new entry `{date, actual, note, passcode}`; once per date; not future; today only after the unlock hour |
| `/api/reconciles` | PUT | correct an entry; the previous value is written to `reconcile_edits` first |

Lockout: 8 failed passcodes per IP per 15 min. The IP is the **last** `X-Forwarded-For`
entry (the one Railway's edge appends — earlier entries are client-supplied). A malformed
`%`-escape in a path returns 400 instead of crashing the process.

## 4. The page

Top to bottom:

- **App bar** (fixed): settings and reconcile icons. A compact "Cash Flow" title and a frosted
  page-coloured background fade in as the large title scrolls under it (see §9).
- **Large title**, then the **tile strip**: Today, Net worth, Ending balance (headline), Buying
  power, Rent net, Car loan, Lowest ahead, Days under $15k ahead, Break-even ROI. Five sale
  tiles (proceeds, payoff, loss credit, relo costs, recapture) show only while a sale is set.
- **Today panel**: today's lines (and today's reconcile), their net, and the next day anything
  posts; tapping "Next" opens Transactions at that month.
- **Chart panel**: year/horizon picker, **Cash | Net worth** switch, the SVG, legend.
- **Transactions** (month pages), **Keep it or sell it?**, **Assumptions & sources**.
- **Sheets**: settings ("Home sale scenario") and reconcile. Bottom sheets on phones (drag the
  grabber to dismiss), centred dialogs on desktop.

## 5. The model

All dates are ISO strings; helpers `dd`, `iso`, `addD`, `addM` (clamps month-end), `nDays`,
`lt`, `bumpWk` (weekend drafts move to Monday), `monthly(day, fromYM, toYM)`.

**Window.** `T0 = 2026-08-14`, `START_BAL = 99026.57`. `T1` is the horizon end, set only by
`setHorizon()` from `HORIZONS` (h5 → 2030-12-31, h15 → 2041-12-31, h30 → 2056-12-31). Every
schedule runs to `TM()` (= `T1`'s month); nothing may hard-code an end year.

**`buildEvents(sale, price, rent, home)`** emits every dated cash line `{d, a, l}` and returns
the sale figures. Categories:

- *Income*: biweekly paychecks (`PAY5`, +3%/yr from 2028 via `payAt`), the March bonus netted at
  65.6%. Each year's tax items are collected with `addTax` and settle as one line on the
  following April 15.
- *OKC home*: closing wire (`nhCashToClose()` from `closingSlices`/`credits`), mortgage from
  Nov 2, 2026 (`nhDates`, `nhEscrowPlan`), utilities (seasonal estimates), pest control (four
  $119 visits Nov 2026–Aug 2027). After payoff, tax and insurance are billed direct
  (`postPayoffBills`).
- *Midland home*: PennyMac mortgage (`mortgageSchedule`, `midEscrowPlan`: the escrow resets each
  June after the Jan tax bill; PMI off Nov 2026), HOA, utilities only while vacant, property tax
  prorated at a sale, escrow refund or deficiency at a sale.
- *Letting*: `rentSchedule` (prorated move-in, then the 1st of each month), management and
  maintenance (`maintPerYear` ramps toward 1% of value after the warranty), placement fee,
  early-termination fee if the tenancy ends before `LEASE.end`, Schedule E taxed at
  `RENT_TAX_RATE`; losses are suspended (`suspendedByYear`) and released at a sale.
- *Sale*: `payoffOn(sale)`; seller costs are 0 inside the relo window (`RELO_DEADLINE`
  2027-07-20) and 7.5% after; loss credit = half the loss under $425k, max $25k, inside the
  window; depreciation recapture on months actually let; capital gains after `SEC121_LAST`;
  car paid off two months after a sale (warranty refund a month later); repay fiancée a week
  after.
- *Everything else*: car loan (`carWalk`, simple interest), Vivint (`VIVINT_*`: paused Oct 2026
  – Sep 2027, final payment 2031-06-20), subscriptions, insurance, NY Life (not inflated).

⚠️ **Nothing rental may count after a sale date** — `rented()` and the Schedule E loop stop at
`sale`, whatever tenancy the caller passed in.

**`buildSeries`** walks each day: interest first (`accrue`: two tiers — cash rate up to the
liquidity floor, investment rate above it; nothing accrues before today), then the day's
events, then a reconcile (if any) **rebases** the balance to the actual.

**The tenancy is derived, not typed** (`leaseEndFor`): "never sell" lets to `T1`; "when the
tenant leaves" ends at `LEASE.end`; a picked date ends it at the sale.

## 6. Net worth (`netWorth`)

cash + OKC equity (value at 3%/yr, less 7% selling costs, less loan) + Midland equity (value at
the appreciation rate, less 7.5%, less `payoffOn`) − car payoff − property tax owed − tax a sale
would trigger (recapture, capital gains, less the suspended losses released so far).

- Property tax **accrues** through the year (plus last year's bill until escrow pays it in
  January), less the escrow balance.
- Loan payments count on the day they draft (`payoffOn(asOf, true)`,
  `carPayoffOn(asOf, true)`), so cash and debt move together.
- The current year's suspended-loss release is pro rata.

## 7. Keep it or sell it?

Two scenarios run through the same engine: **keep** (`keepRent` — let to `T1`, never sell) and
**sell** (`oppExitDate()`, tenancy cut to the exit by `sellRent`). Both earn the same rate spec,
so the only difference is the house.

- **Horizon table** (`oppAcrossHorizons`): net worth of each at `T1` for all three horizons
  (swaps `T1`, restores it in `finally`), and the **break-even ROI** — the investment rate at
  which they tie (`breakEvenROI`, bisection; keep−sell falls monotonically with the rate). Rows
  are tappable: they set the horizon.
- **Exits table** (`fillOppPanel`): Today, last day of the relo window, the day after, the
  default exit (`OPP_EXIT` 2027-10-01), and **the date waiting makes the relo loss back** — the
  first day `price × (1 − 7.5%) − payoff`, deflated to today's dollars, reaches what selling on
  the window's last day is worth. Built against the 30-year horizon so that date can land past
  the chosen one. Columns include sale price and today's dollars. Rows are tappable: the pick
  (`OPP_SEL`) becomes the sell side everywhere; tapping it again restores the default.
- **Cash | Net worth**: in Net worth mode the chart plots both scenarios' net worth, sampled
  weekly and interpolated (end points equal the table). Opening the panel switches to it.

Everything the panel computes is memoised in `OPPC`, keyed on its real inputs (including
`OPP_SEL`), not on the chart window.

## 8. State and how it stays in sync

| State | Set by | Read by |
|---|---|---|
| `HORIZON` / `T1` | `setHorizon` — chart picker, sheet buttons, horizon rows | everything |
| `VIEW` (`'span'` or a year) | chart picker / arrows, `followPage` | chart, tiles, table |
| `TPAGE` | pager; follows the chart year (and moves it) on single-year views | Transactions |
| `CHART_MODE` | switch; opening/closing the panel | chart |
| `SALE_MODE` | sheet | `leaseEndFor`, `syncSaleDate` |
| `OPP_SEL` | exit rows | `oppExitDate` |

The **sheet batches**: edits mark it dirty and preview cheap things live (`previewDates` →
`syncSaleDate`, `sheetNotes`, a debounced `oppPreview`); **Apply** recomputes. The sheet is
snapshotted on open (`snapSheet`); Close, Escape, the backdrop and drag-to-dismiss **revert**
(`revertSheet`) and recompute nothing. Reset applies the defaults at once.

## 9. UI mechanics worth knowing

- **iOS status bar.** `apple-mobile-web-app-status-bar-style` is `default`. iOS paints the strip
  itself from `theme-color` and a home-screen app reads it **only at launch** — so it is set to
  the page colour before load, and the app bar and every overlay use the page colour, never a
  contrasting one. Nothing on the page can paint, dim or blur that strip.
- **App bar** is `position: fixed`, and its title/background opacities are written as inline
  styles from `window.scrollY` (tracked every frame from touch or scroll until still). Custom
  properties on a sticky bar did not reliably repaint on iOS. The two titles are never visible
  together.
- **Loading**: one spinner. `busy(hosts, fn)` covers the recomputing area (or the whole page
  with `hosts = null`), centres the ring on its on-screen part, runs `fn` after the next painted
  frame or 120 ms, and holds at least ~220 ms. Network buttons show an inline ring
  (`btnLoading`); a boot screen holds until reconciliations load.
- **Text**: descriptions beside amounts are one line (`.trunc`); hover shows the full text, a tap
  or press-and-hold opens it. Tile figures shrink to fit (`fitTiles`), then compact ($1.23M).
- **Performance**: `mortgageSchedule`, `midEscrowPlan`, the sorted escrow notes and
  `rentSchedule` are memoised (their results must never be mutated). 30-year net-worth sampling
  is ~0.3 s.

## 10. Common edits

| Task | Where |
|---|---|
| Add or change a recurring bill | `buildEvents` — an `E(date, amount, label)` or a date list; wrap in `inflAt(d)` if it should inflate |
| One-off facts (rates, dates, amounts) | the constants near the top of the script (`LEASE`, `VIVINT_*`, `NH_*`, `MID_*`, `CAR_*`, …) |
| A new setting | markup in `#setmodal`, read it in `render`/`readRent`, add to `sheetNotes` if it has a live note; `FORM_DEFAULTS` and the snapshot pick it up |
| A new tile | markup in `#tiles` + `set('t_x', …)` in `render` (add class `saleonly` if it needs a sale) |
| Extend the horizons | `HORIZONS` and `RANGE_END` in `server.js` |
| Change the icon | `public/icon.svg`, regenerate the four PNGs, and the three data URLs in `<head>` |

After a change: hard-refresh (HTML is served `no-store`), and on iPhone fully close and reopen
the home-screen app; changes to status-bar settings need it re-added from Safari.

## 11. Testing notes

- A Node harness can run the page's script against a stubbed DOM to check the model (horizons
  agree on shared dates; the keep/sell table does not move with the selected horizon).
- Headless Chrome, served locally, for real renders. It will not go below a ~500 px viewport, so
  phone views are rendered in 390 px iframes; an iframe's `color-scheme` sets its light/dark mode.
- In `--dump-dom` mode no animation frames run, so anything behind `requestAnimationFrame`
  needs the screenshot mode (or `busy`'s timer fallback); `performance.now()` does not advance
  during work under a virtual time budget, so time the model in Node instead.

## 12. Assumptions still worth confirming

- `MID_TAX_NONHS` ($5,874.36) is a 1.30× estimate of the non-homestead Midland tax.
- The OKC tax ($6,000/yr) is an assumption, not an assessment.
- The lease-break fee (2 months' rent) is not in the lease.
- Utilities are seasonal estimates; the Midland insurance is the owner-occupied premium, not a
  landlord policy.
- Net worth assumes OKC appreciates 3%/yr and sells at a 7% cost.
