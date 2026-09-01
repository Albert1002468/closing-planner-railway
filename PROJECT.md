# Closing & Home-Sale Planner — project reference

A personal cash-flow planner for a new-home closing on **Fri Sept 18, 2026** and the
sale of the current (Midland, TX) home. Projects a daily bank balance from **2026-08-14
through 2027-12-31**, driven by two user inputs (home sale date + price), and lets the
owner lock in permanent daily reconciliations against the real account balance.

Built from ~7 months of Wells Fargo statements + two Coterra paystubs. Deployed on Railway.

---

## 1. Stack & layout

Zero npm dependencies. Pure Node (`node:http` + `node:sqlite`), vanilla JS, hand-rolled SVG charts.
Nothing to compile; no build step.

```
/
├── server.js          # HTTP server + reconcile API + static file serving
├── package.json       # no deps; "start": "node server.js"; engines node >=22
├── README.md          # deploy instructions
├── .gitignore
└── public/
    ├── index.html     # THE ENTIRE APP — markup, CSS, engine, charts, reconcile UI
    ├── manifest.json  # PWA manifest (installable to home screen)
    ├── icon-512.png  icon-192.png  apple-touch-icon.png  favicon-32.png
```

**Everything client-side lives in `public/index.html`.** One file, ~870 lines:
`<style>` block → markup → one `<script>` with the engine, renderer, and reconcile logic.
The app icon is *also* embedded in that file as a base64 data URL, so the HTML works
standalone (opened via `file://`) with no assets.

---

## 2. Deployment (Railway)

| Env var | Value | Notes |
|---|---|---|
| `RECONCILE_PASSCODE` | your PIN | **Required to save.** Unset ⇒ read-only mode. |
| `DATA_DIR` | `/data` | Must match the volume mount path. |
| `RECONCILE_UNLOCK_HOUR` | `19` (default) | Hour today unlocks, 0–23, America/Chicago. |
| `PORT` | *(Railway injects)* | Never set manually. |

**A volume mounted at `/data` is mandatory** — without it, Railway's filesystem is
ephemeral and every redeploy wipes the reconciliations.

Health check: `GET /api/state` should return `"saveEnabled": true` and `"storage": "sqlite"`.
If storage says `"json"`, Node is < 22 and it fell back to a JSON file (still works).

Note: attaching a volume disables zero-downtime deploys — expect a few seconds of downtime.

---

## 3. Server API (`server.js`)

| Route | Method | Purpose |
|---|---|---|
| `/api/state` | GET | today (America/Chicago), current hour, unlockHour, range, saveEnabled, storage kind, **all reconciles** |
| `/api/verify` | POST | `{passcode}` → `{ok:true}` or 401. Gates the PIN screen; reveals no data. |
| `/api/reconciles` | POST | `{date, actual, note, passcode}` → creates one permanent entry |
| `/*` | GET | static from `public/`, SPA fallback to `index.html` |

**Storage:** `node:sqlite` → `$DATA_DIR/planner.db`, table
`reconciles(date TEXT PRIMARY KEY, actual REAL, note TEXT, created_at TEXT)`.
Falls back to `$DATA_DIR/reconciles.json` if `node:sqlite` is unavailable.

**All reconcile rules are enforced server-side** (a manipulated device clock or devtools
can't bypass them):
- future dates rejected
- today rejected before `UNLOCK_HOUR` local
- past dates with no entry always allowed (no time restriction)
- one entry per date, ever — duplicates 409
- date must fall inside 2026-08-14 … 2027-12-31
- 8 failed passcode attempts from one IP ⇒ 15-minute lockout
- passcode compared with `crypto.timingSafeEqual`

**There is deliberately no delete or edit route.** Removing an entry means SSHing in:
```bash
node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/data/planner.db');console.log(db.prepare('DELETE FROM reconciles WHERE date = ?').run('2026-08-22'))"
```

---

## 4. The engine (in `index.html`)

Three functions, in order:

**`buildEvents(sale, price)`** → `{ev, payoff, proceeds, loss, vivFee, vivMonthsLeft}`
Emits every dated cash movement. `E(date, amount, label)` — positive in, negative out;
silently drops anything outside T0…T1. Split into fixed events and sale-dependent ones.

**`buildSeries(sale, price)`** → `{series, …}`
Walks day by day from `START_BAL`, applying each day's events. On a day with a reconcile it
records `{actual, projected, delta, note}` and then **rebases** the running balance to the
actual — so every later day shifts by the variance. This is the core behavior.

**`render()`**
Reads the two controls, rebuilds the series, redraws the donut + timeline SVGs, updates the
stat tiles, and rewrites the transaction table. Called on every input change and on resize.

### Key constants (top of the script)

```js
START_BAL   = 99026.57      // available balance, morning of 8/14/26
T0, T1      = '2026-08-14', '2027-12-31'
PAY10, PAY5 = 3830.28, 3557.15   // net paycheck w/ 10 and 5 OT hrs
MTG_BAL_AFTER_AUG = 336756.31    // current-home principal after Aug payment
MTG_RATE = 0.05375, MTG_PI = 2131.90, MTG_PMT = 2318.72
AF_PAYOFF_DATE = '2026-08-20', AF_PAYOFF_AMT = 1436.90
VIVINT_RATE = 59.99, VIVINT_LOW = 8.58, VIVINT_START = '2025-06-21', VIVINT_TERM = 60
NH_PMT_26 = 2691.97, NH_PMT_27 = 3180.72   // new-home payment; escrow steps up Jan 1 2027
CAR_RATE = 0.0674, CAR_PMT = 824.76
CAR_ANCHOR = '2026-08-16', CAR_BAL_AFTER_ANCHOR = 40862.63
WARRANTY_REFUND = 2300.00, FIANCEE_REPAY = 27000.00
BONUS_DATE = '2027-03-01', BONUS_GROSS = 30000.00, BONUS_NET = 19680.00
IRS_DATE = '2027-03-19', IRS_AMT = 5000.00
```

### Date helpers (all dates are ISO strings, never Date objects in the model)

`addD(s,n)` days · `addM(s,n)` months, clamped to month end (Dec 31 + 2mo → Feb 28) ·
`nDays(a,b)` · `bumpWk(d)` weekend → next business day (ACH drafts) ·
`monthDays(day,fromYM,toYM)` raw due dates · `monthly(...)` the same, weekend-bumped.
`monthly` reproduces every hand-entered 2026 date array exactly **except** the Claude
subscription, which is an Apple *card charge* and posts on Sat 11/14/26 without bumping.
2026 arrays are therefore left literal; only 2027 is generated.

### Car-loan math (rule 1)

Simple interest, **actual/365** — not monthly amortization. Anchored on the 8/27/26
statement, which split the payment $587.47 principal / $237.29 interest:

```
(40,862.63 + 587.47) x 6.74% / 365 x 31 days = 237.28   ✓ matches the statement
```

so the principal standing after the 8/16/26 payment is **$40,862.63**. The original
$55,109.81 / 6-20-2025 loan and the ~14 extra $500 payments are already baked into that
anchor and are *not* re-simulated. **No further extra payments are assumed.**

`carWalk(stopBefore)` applies payments strictly before a date and returns the running
principal; `carPayoffOn(date)` adds per-diem interest since the last posted payment. The
same walk drives both the payment events and the payoff quote, so the two cannot disagree.
Without a payoff the loan would run to ~Feb 2031.

### Payroll math (how PAY10 / PAY5 were derived)

From two paystubs differing only in overtime:
- marginal take-home **62.35%** of gross (24% fed + 6.2% OASDI + 1.45% Medicare + 6% Roth)
- **$54.63 net per OT hour** (OT gross rate $87.615)
- **zero-OT check = $3,283.99**; each OT hour adds $54.63
- 26 checks/year ⇒ 10 two-check months and 2 three-check months

### Sale-dependent logic

| Thing | Rule |
|---|---|
| PennyMac payments | drafted only while unsold; exact amortization at 5.375% from $336,756.31 |
| Loan payoff | remaining principal + per-diem interest since the last payment |
| Proceeds | `price − payoff`, landing **on** the sale date (relo covers commissions/seller costs) |
| Relo interest reimbursement | day after each payment, **max 2 payments** |
| Loss-on-sale credit | `min(25000, max(0, 425000 − price) × 0.5)`, **14 days after** sale |
| Midland utilities | Cirro / Atmos / water stop at sale + one $150 trailing bill 10 days later |
| Vivint | $8.58/mo until buyout; **7 days before sale** pay `monthsLeft × $59.99 × 0.5`; drafts stop |
| AutoFortiva | single $1,436.90 on 8/20/26 — no monthly drafts (loan settled) |
| Fiancée repayment | **$27,000 exactly 7 days after** the sale — her stake in the Midland home, funded from proceeds |
| Car payoff | `addM(sale, 2)`; the $824.76 drafts stop that day |
| Warranty + gap refund | **+$2,300 one month after** the car payoff |

### Fixed events (not sale-dependent)

Paychecks; the $104,462.90 closing wire on 9/18; Airbnb refunds on 9/19 (+$234 day refund,
+$750 pet deposit); new-home mortgage $2,691.97 on 11/2 and 12/1
(first payment Nov 1 because interest is prepaid through 9/30), then **$3,180.72 monthly
through 2027**; the **$30,000 bonus on 3/1/27 (net $19,680)** and the **$5,000 IRS payment
on 3/19/27**; car $824.76 on the 16th until payoff;
AT&T $80.65; card autopays ~$50; NY Life $59.10; Apple Cash $112; Claude $21.65; iCloud+ $0.99;
Spotify $20.56; car insurance $940 on 9/25 and each 6 months after (3/25/27, 9/27/27);
new-home utilities $150 / $250 / $300 Oct–Dec 2026, then a seasonal 2027 table
($195 in May up to $330 in Jan and Aug) — **estimates, not statements**.
2027 paychecks are generated biweekly from 12/25/26: 26 checks, three-check months
**April and October**.

**Food and miscellaneous are $0** — the spouse covers them.

---

## 5. Closing figures (the donut — collapsed by default)

The card is a native `<details class="card acc">`, **closed on load**. The chevron is our own
(`.accchev`, rotated 180° by `details.acc[open]`); the default marker is removed with
`list-style:none` + `::-webkit-details-marker`.

Anything shown while collapsed must live **inside `<summary>`**, since a closed `<details>`
hides all its other children. That is `#accsum` — cash due, the wire date, gross costs,
credits, down payment and points — hidden again by `details.acc[open] .accsum{display:none}`.
**It is generated by the donut IIFE from the same `slices`/`credits` arrays**, so the collapsed
figures cannot drift from the chart. Add a slice and the strip follows automatically.

The donut still draws at parse time while hidden; its fixed `viewBox` means it needs no layout,
and the tooltip measures on mousemove, when the card is necessarily open.



| Item | Amount |
|---|---|
| Down payment (20% of $529,900) | $105,980.00 |
| Discount points (lender 2 @ 5.99%) | $12,000.00 |
| Fence — buyer's half of $7,230 | $3,615.00 |
| Homeowners insurance, 12 mo | $1,702.00 |
| Prepaid interest, 13 days | $904.40 |
| Escrow — 3 mo insurance | $425.50 |
| Escrow — 12 mo property tax | $135.00 |
| **Gross** | **$124,761.90** |
| Builder/seller credit | −$15,000.00 |
| Earnest money (wired 8/12) | −$5,299.00 |
| **Cash due at closing** | **$104,462.90** |

⚠️ **Property tax reassessment** — now modeled (rule 6). The $135/yr on the Closing
Disclosure is the *unimproved lot*. Backing P&I out of the $2,691.97 payment confirms the
split to the penny:

```
loan 423,920 @ 5.99% / 360 mo  ->  P&I 2,538.89
2,691.97 - 2,538.89            =  escrow 153.08  =  1,702/12 + 135/12   ✓
```

At the **assumed $6,000/yr** tax the escrow becomes `141.83 + 500.00 = 641.83`, so the
payment steps to **$3,180.72** (+$488.75) **effective with the Jan 1, 2027 payment**, with
**no shortage spread** — both per the owner's instruction. A full reassessment at
$529,900 × ~11% × 129.51 mills would be ~$7,547/yr instead, i.e. ~$129/mo more than modeled.

---

## 6. Reconciliation feature

**Trigger:** a deliberately low-contrast button below the chart footnotes, right side
(`#recbtn`, one shade off the page background in each theme). Hidden entirely unless at
least one date is eligible.

**Flow:** click → centered modal opens on a **PIN screen** → `POST /api/verify` → only then
does the form render.

**Form:** date dropdown (eligible dates only) · **− Short / + Over** sign toggle · amount
field (`type=text`, `inputmode=decimal` — mobile keypads have no minus key) · optional note ·
a live result box showing projected balance → variance → **new balance**.

**Display rules:**
- variance ≠ 0 → appears in the transaction table *and* the timeline tooltip
- variance = 0 → saved and locks the date, but **hidden from both**; visible only in the
  modal's "Recorded" list
- the stored value is the **resulting balance** (a hard fact), not the variance — so it stays
  correct when the sale scenario changes; the variance is re-derived on the fly

---

## 7. Chart / UI details worth knowing

- **Timeline** is hand-drawn SVG, re-rendered at *mobile geometry* below 640px (not merely
  scaled) so axis text stays legible. `viewBox` is sized to the container for 1:1 text.
- **TODAY marker**: dashed rule + label, with the elapsed region shaded. Uses the server's
  date when online so a wrong device clock can't drift it.
- **Marker labels draw last**, after the event triangles, with a `paint-order: stroke` halo —
  otherwise the data line, triangles, or the SALE rule cut through them. The SALE label drops
  to a second line when it lands within 58px of TODAY.
- **Touch**: uses **Pointer Events**, not touch+mouse. On touch the readout *docks* to the top
  or bottom edge — whichever is opposite the finger — instead of hiding under it, and stays
  6 seconds after lift. Mixing touch and mouse handlers breaks this: browsers fire synthetic
  mouse events after a tap that un-dock the readout.
- **Window control** (`.vbtn`, `VIEW` = `all` | `2026` | `2027`) slices the series for the
  chart only. Tiles stay whole-series — "Lowest point" is a bridge-sizing number and must not
  change when you page to 2027. `ti`/`si` are indices into the *windowed* array, so the
  today-balance tile computes its own index (`tdi`) into the full array.
- **Axis label thinning**: 17 months will not fit. `mStep` is 1–3 by width, January is always
  labelled and carries the year (`Jan '27`), and the spacing counter **resyncs from January**
  so you never get Dec/Jan/Feb in a row.
- **Table** shows a true per-transaction running balance (`run`), resynced to the day's close
  after each day so a reconcile rebase carries. Every row is built over the whole series, then
  **only the selected month is written to the DOM** — pages follow the window control, so
  picking "2027" scopes the pager to 12 pages. `PMONTHS` / `TPAGE` hold the paging state.
  The pager cannot use the `$` helper: it is declared `const` further down and is still in the
  TDZ when `render()` first runs.
- **Scenario controls** sit in one bordered panel (`.controls`). The sale price is a **text**
  input, not `number`, so it can carry thousands separators; `priceVal()` strips non-digits and
  clamps to the slider's `min`/`max`, and is the single source of truth for the price. It
  reformats on **blur only** — reformatting on every keystroke fights the caret. Empty or
  garbage input falls back to the slider value rather than producing `NaN`.
- **"Never sold" is a toggle switch** (`.switch`) built from a visually-hidden checkbox plus a
  `.track` span; `#notsold` keeps its id and change handler, so the engine is untouched.
- **Theme**: CSS custom properties are defined on **`:root` *and* `.viz-root`**. Defining them
  only on `.viz-root` makes `body`'s `var(--page)` invalid and the page gutters render white in
  dark mode.
- Modal needs `box-sizing: border-box` or `max-height` excludes its padding and it overflows
  short viewports.

---

## 8. Current headline numbers (Oct 30 sale @ $425k, no reconciles)

- Sept 18 morning balance: **$104,025.13** vs a **$104,462.90** wire → **~$438 short**
  (~8 OT hours, or fold into the bridge)
- Lowest point: **−$3,114.63 on Oct 1** (PennyMac lands before the Oct 2 paycheck)
- **Underwater Sept 25 → Oct 1** — the $940 insurance draft on 9/25 tips it negative and it
  stays there until the Oct 2 paycheck → the **~$3,500 bridge must be in place by Sept 25**,
  not Sept 30
- Vivint buyout: **$1,289.79** (43 months left)
- Fiancée repayment **−$27,000 on Nov 6**; car payoff **−$38,563.57 on Dec 30**
- Dec 31, **2026**: **$34,641.71** (was ~$100,205 before rules 1 and 5 — those two
  withdrawals account for $65,563.57 of the drop)
- Warranty refund **+$2,300 on Jan 30, 2027**; bonus **+$19,680 on Mar 1**; IRS **−$5,000 on Mar 19**
- Dec 31, **2027**: **$96,709.57**

**The two big withdrawals both land after the proceeds do**, so neither creates a new
trough — the Oct 1 low is still the binding constraint. Selling later pushes the car payoff
later and costs *less* ($37,334 if the payoff slips to Feb 2028 vs $39,087 in Nov 2026).

**2027 steady state, one home, no car payment, 5 OT hrs/check:** income $7,707/mo −
expenses ~$3,830/mo = **+$3,278 in a two-paycheck month** and **+$6,941 in the two
three-paycheck months (April and October)**. Cheapest month is May (−$3,721), dearest is
September (−$4,736, the insurance renewal).

---

## 9. Common edits

| Task | Where |
|---|---|
| Add/remove a recurring bill | `buildEvents` — add an `E(date, amount, label)` or a date array |
| Extend past Dec 31, 2027 | `T1` **and** `RANGE_END` in `server.js`; extend `mortgageSchedule`, `CAR_DATES`, the 2027 utility tables, and add a window button |
| Change the assumed property tax | `NH_PMT_27` — recompute as `2538.89 + 1702/12 + tax/12` |
| Move the escrow step-up date | the `d<'2027-01-01'` test and the `monthly(1,…)` split in `buildEvents` |
| Change the bonus | `BONUS_GROSS`; `BONUS_NET` re-derives at 65.60% |
| Resume extra car payments | `carWalk` — add to `CAR_PMT` for the relevant dates |
| Change the reconcile unlock hour | `RECONCILE_UNLOCK_HOUR` env var (client syncs from `/api/state`) |
| Change closing costs | the `slices` / `credits` arrays near the top of the script |
| Add a stat tile | markup in `.tiles` + a `set('t_xxx', …)` call at the end of `render()` |
| Change what the collapsed closing card shows | the `#accsum` block at the end of the donut IIFE |
| Open the closing card by default | add `open` to `<details id="closingcard">` |
| Change the sale-price range | `#pricer` `min`/`max` (`PRICE_MIN`/`PRICE_MAX` read from it) and the `.rends` labels |

After any change: hard-refresh (HTML is served `no-store`), check the browser console, and
confirm the table's last balance matches the Dec 31 tile.

---

## 10. Assumptions to revisit

- Relo covers commissions and seller closing costs (proceeds = price − payoff)
- Proceeds land on the sale date; loss credit exactly 14 days later
- Interest reimbursement is capped at 2 payments and lands the day after each
- Current-mortgage rate 5.375% was **back-solved** from one payment split — confirm against a statement
- New-home utilities are estimates (OG&E + ONG + OKC water/trash)
- No security service budgeted at the new house after the Vivint buyout
- No maintenance reserve for the new home
- The Midland home's own property taxes (escrow is only $186.82/mo — likely insurance only)
  may be a large out-of-pocket bill due Jan 31, 2027 — **still not modeled**
- New-home property tax is the owner's **$6,000/yr assumption**, not an assessment; the
  escrow step is placed at Jan 1, 2027 with no shortage spread. A real lender analysis will
  likely land later in 2027 and may add a shortage instalment
- 2027 utilities (both homes) are seasonal guesses, not statements
- The bonus is netted at **65.60%** — last year's 70.35% (22% fed supplemental + 6.2% + 1.45%)
  less Oklahoma's 4.75% supplemental rate. Assumes no Roth deferral is taken on the bonus,
  which is what last year's $22,512/$32,000 implies, and that OASDI is not yet capped by March
- The car payoff assumes the lender quotes plain principal + per-diem with **no early-payoff
  fee**; get a written 10-day payoff quote before wiring
- The $2,300 warranty/gap refund is assumed to arrive as cash one month after payoff — some
  lenders instead apply it straight to the loan, which would reduce the payoff rather than
  pay you back
