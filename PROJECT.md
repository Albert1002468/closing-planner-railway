# Closing & Home-Sale Planner — project reference

A personal cash-flow planner for a new-home closing on **Fri Sept 18, 2026** and the
sale of the current (Midland, TX) home. Projects a daily bank balance from **2026-08-14
through 2026-12-31**, driven by two user inputs (home sale date + price), and lets the
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

**Everything client-side lives in `public/index.html`.** One file, ~1,100 lines:
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
- date must fall inside 2026-08-14 … 2026-12-31
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
T0, T1      = '2026-08-14', '2026-12-31'
PAY10, PAY5 = 3830.28, 3557.15   // net paycheck w/ 10 and 5 OT hrs
MTG_BAL_AFTER_AUG = 336756.31    // current-home principal after Aug payment
MTG_RATE = 0.05375, MTG_PI = 2131.90, MTG_PMT = 2318.72
AF_PAYOFF_DATE = '2026-08-20', AF_PAYOFF_AMT = 1436.90
VIVINT_RATE = 59.99, VIVINT_LOW = 8.58, VIVINT_START = '2025-06-21', VIVINT_TERM = 60
```

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

### Fixed events (not sale-dependent)

Paychecks; the $104,462.90 closing wire on 9/18; Airbnb refunds on 9/19 (+$234 day refund,
+$750 pet deposit); new-home mortgage $2,691.97 on 11/2 and 12/1
(first payment Nov 1 because interest is prepaid through 9/30); car $824.76 on the 16th;
AT&T $80.65; card autopays ~$50; NY Life $59.10; Apple Cash $112; Claude $21.65; iCloud+ $0.99;
Spotify $20.56; car insurance $940 on 9/30 (6-month policy, next renewal ~Mar 2027);
new-home utilities $150 / $250 / $300 Oct–Dec.

**Food and miscellaneous are $0** — the spouse covers them.

---

## 5. Closing figures (the donut)

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

⚠️ **Property tax reassessment is the big lurking change.** The $135/yr is the *unimproved
lot*. Once the finished house is assessed: $529,900 × ~11% ratio × 129.51 mills ≈
**$7,547/yr (~$629/mo)** vs the $11.25/mo being escrowed — a ~**$618/mo** escrow jump,
pushing the housing payment to about **$3,310/mo**. Not modeled in the timeline (it lands in 2027).

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
- **Table** shows a true per-transaction running balance (`run`), resynced to the day's close
  after each day so a reconcile rebase carries.
- **Theme**: CSS custom properties are defined on **`:root` *and* `.viz-root`**. Defining them
  only on `.viz-root` makes `body`'s `var(--page)` invalid and the page gutters render white in
  dark mode.
- Modal needs `box-sizing: border-box` or `max-height` excludes its padding and it overflows
  short viewports.

---

## 8. Current headline numbers (Oct 30 sale @ $425k, no reconciles)

- Sept 18 morning balance: **$104,025.13** vs a **$104,462.90** wire → **~$438 short**
  (~8 OT hours, or fold into the bridge)
- Lowest point: **−$3,114.63 on Oct 1** (car insurance + PennyMac land before the Oct 2 paycheck)
  → stage a **~$3,500 bridge** from the other account before closing week
- Dec 31: **~$100,205**
- Vivint buyout: **$1,289.79** (43 months left)

**2027 steady state, one home, 5 OT hrs/check:** income $7,707/mo − expenses $4,939/mo
(incl. the reassessed tax) = **+$2,768/mo average** — but that's **+$2,175** in normal
two-paycheck months and **+$5,732** in the two three-paycheck months.

---

## 9. Common edits

| Task | Where |
|---|---|
| Add/remove a recurring bill | `buildEvents` — add an `E(date, amount, label)` or a date array |
| Change the sale-price slider range | `#price` / `#pricer` `min`/`max` in the markup |
| Extend past Dec 31 | `T1`, then extend every hardcoded date array |
| Change the reconcile unlock hour | `RECONCILE_UNLOCK_HOUR` env var (client syncs from `/api/state`) |
| Change closing costs | the `slices` / `credits` arrays near the top of the script |
| Add a stat tile | markup in `.tiles` + a `set('t_xxx', …)` call at the end of `render()` |

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
  may be a large out-of-pocket bill due Jan 31, 2027
