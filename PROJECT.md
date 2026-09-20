# Closing & Home-Sale Planner — project reference

A personal cash-flow planner for a new-home closing on **Fri Sept 18, 2026** and the
sale of the current (Midland, TX) home. Projects a daily bank balance from **2026-08-14
through 2030-12-31**, driven by two user inputs (home sale date + price), and lets the
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
- date must fall inside 2026-08-14 … 2030-12-31
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
T0 = '2026-08-14';  T1 is CHOSEN, not fixed — see HORIZONS
HORIZONS = {h5:'2030-12-31', h15:'2041-12-31', h30:'2056-12-31'}   // 1.6k / 5.6k / 11.1k days
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
RELO_DEADLINE = '2027-07-20', SELLER_COST_PCT = 0.075
RENT_DEFAULT = {start:'2026-10-01', months:36, amt:3300}   // rent 3 yrs, then sell
RAISE_PCT = 0.03, INFL_PCT = 0.03          // both apply from 2028 only
DEPREC_YEARS = 27.5, RECAP_DEFAULT = {basis:373210, rate:29.75}   // Midland CAD improvements line
LANDLORD_DEFAULT = {mgmt:10, vacancyMo:1, maint:2500}, RENT_ESCAL_DEFAULT = 3
MID_INS = 1329.00, MID_PMI = 28.75, MID_PMI_OFF = '2026-11-01'
MID_LAND_TAX = 567.84, MID_ESC_START = 977.26   // statement said 1,135.33 AFTER the Sept 1 draft
ESC_CUSHION_MO = 2, ESC_ANALYSIS_M = 6          // analysis effective with the June draft
MYRENT_DEFAULT = {start:'2026-09-18', months:12, amt:2200, util:120}
BUY_DEFAULT = {cash:104462.90, pmt:3180.72, cc:8000}, BUY_LEAD_MONTHS = 2
```

### Your own housing: buy or rent (rule 9)

`home` is `{own:true}` or a lease `{own:false, start, months, amt, util, buy}`. **In rent mode
the Sept 18 purchase does not happen at all**, so `buildEvents` drops the $104,462.90 wire, the
new-home mortgage, the escrow step-up, the new-home utilities, and the **relo interest
reimbursement** (it exists to offset carrying two mortgages). It adds a prorated first month if
the lease starts mid-month, monthly rent on the 1st, and flat `util` while renting.

Your own rent **steps up on each lease anniversary** (`#hescal`, default 3%) on the same
`Math.floor(i/12)` rule as the Midland tenancy, and renter utilities **inflate through
`inflAt`** like every other cost — 3%/yr from 2028.

⚠️ **The renter-utilities end month must be `T1.slice(0,7)`.** It was hardcoded `'2027-12'`
from the old horizon, so any lease running past 2027 silently stopped paying utilities while
still paying rent. Grep for other hardcoded `'2027-12'` / `'2030-12'` month bounds whenever the
horizon moves — `mortgageSchedule` had the same disease.

`#hterm` allows **60 months**, matching `#rentterm`; the 36 cap could not express a lease
covering the window.

The **earnest money is treated as forfeited** — it left the account on 8/12, before `START_BAL`,
so rent mode records nothing new. If it is actually refunded you are $5,299 better off than shown.

`ownedFrom` is the single switch for "do I own a house here": `2026-09-18` when buying, the
purchase date in rent-and-then-buy, `null` while renting. New-home utilities key off it.

**A later purchase may close at most `BUY_LEAD_MONTHS` (2) before the lease ends** — that is the
floor on `#hbuydate`, mirroring how the Midland sale is floored by the tenancy. Its first
mortgage payment skips a month (`addM(buyDate, 2)`), the same way the Sept 18 deal first pays
Nov 1. Renter utilities stop at the purchase; the rent itself runs to the end of the term,
because the lease is still owed.

**Buyer closing costs (`buy.cc`, default $8,000) are charged only when the purchase closes after
`RELO_DEADLINE`** — inside the window relo absorbs them, which is why they never appear in the
donut. They are an input because they vary.

The rent-out default now frees the house **Apr 1, 2027**, comfortably inside the relo window,
so switching it on shows the green note rather than the red one it used to.

**The lease length decides whether a purchase can beat the deadline.** From a 9/18/2026 start,
**11 months is the longest lease** that still allows a closing inside the window: it ends
9/1/2027, so the earliest purchase is 7/1/2027. Twelve months ends 10/1/2027 and forces an
8/1/2027 purchase — two weeks late, $8,000.

### Growth in the out-years (rules 10-11)

**2026 and 2027 are modelled from statements and must never move.** `inflAt(d)` and `payAt(d)`
both raise `(1+pct)` to `max(0, year-2027)`, so they return exactly **1x for 2027** and the whole
near-term projection is untouched — the regression guard is that Sept 17 2026 is still
$100,194.85 and Dec 31 2027 still $96,709.57.

- **Pay** rises 3%/yr from the first cheque of 2028: $3,557.15 -> $3,663.86 -> $3,773.78 -> $3,886.99.
- **Costs** inflate 3%/yr from 2028 — utilities, insurance, subscriptions and the **escrow half**
  of the new-home payment (`nhPmtAt` = fixed `NH_PI` + inflating `NH_ESC_27`). The mortgage P&I
  and the car payment are contractual and never inflate.
- **Bonus** is flat $30,000 gross / $19,680 net each March, with the **$5,000 IRS payment**
  alongside it, 2027 through 2030.
- `seasonal(days, amts, fromY, toY)` carries the 2027 utility shapes forward rather than
  hand-typing 36 more rows; 2026/2027 literals stay literal.
- Vivint drafts are guarded by `vivintMonthsLeft(d)>0` — the 60-month term from 6/21/2025 runs
  out mid-2030 and would otherwise bill forever.

Approximating a gross raise as an equal net raise is fine at the margin (62.35% marginal take-home)
but ignores bracket drift.

### Depreciation recapture (rule 12)

Only bites when the Midland home is **rented and then sold**. Because the sale floor already
forces the sale past the end of the tenancy, months rented always equals the full term:

```
dep = basis / 27.5 / 12 x months        tax = dep x rate      due Apr 15 of the following year
```

Default basis **$373,210 — the improvements line from the Midland CAD assessment** (land is
never depreciable) and **29.75% = 25% federal unrecaptured
Sec.1250 + 4.75% Oklahoma**. Oklahoma taxes its residents on all income wherever earned, so the
gain on a Texas house is still OK-taxable, and because **Texas levies no income tax there is no
resident credit to offset it**. Oklahoma's capital-gains deduction only covers OK-located
property, so it does not help either. Both basis and rate are inputs — confirm with a CPA.

Capital gain beyond the recapture is **not** modelled: the loss-on-sale credit implies the home
is worth less than was paid, and Sec.121 would cover a modest gain anyway.

### Midland property tax (rule 13)

⚠️ **One selling-cost figure, not two.** `netWorth` used to value the unsold Midland house at
a private `SELL_COST = 7%` while the sale engine charges `SELLER_COST_PCT = 7.5%` — so the
net-worth tile and the proceeds tile disagreed by half a point of the price (~$2,100 today,
growing). Midland now uses `SELLER_COST_PCT` everywhere. OKC keeps its own `OKC_SELL_COST`
haircut: nothing in the model ever sells it, so there is no engine to match.

Absent from the model until 2026-09-02 — the PennyMac escrow (`MTG_PMT - MTG_PI = $186.82/mo`)
is **insurance only**, so four years of Texas property tax sat in no balance anywhere.

Texas bills the **calendar year**, due **Jan 31 of the following year**, prorated and settled at
closing on a sale. The homestead exemption keys off occupancy on **Jan 1**, so it survives the
2026 bill and is lost from the **2027** tax year once the house is a rental.

**PennyMac escrows the tax — it is inside the monthly payment, not a separate cheque.** The
escrow looks impossibly small only because the house was **built and bought mid-May 2025**, so
it was set against a **Jan 1 2025 assessment of bare land**:

```
$186.82/mo = $28.75 PMI + $110.75 insurance ($1,329/yr) + $47.32 land tax ($567.84/yr)
```

Deposits of $158.07/mo against disbursements of $158.07/mo — **exact equilibrium**, which is
what confirms the split. The first assessment including the house is **Jan 1 2026, billed Jan
31 2027**; that one disbursement blows the account open.

**Both homes run on one engine, `escrowPlan(cfg)`.** The OKC escrow has the identical defect —
set at closing against an unimproved lot ($135/yr), funded with $560.50, collecting $153.08/mo —
so modelling Midland properly and leaving OKC as a clean Jan-2027 step was an inconsistency, not
a simplification. `midEscrowPlan()` and `nhEscrowPlan()` are now two configs of the same walk.

The analysis **projects the next twelve months and targets the LOW point**, rather than
comparing against today's balance. That distinction is the whole point: at OKC's Dec 2027
analysis the account is still +$713, and only a forward projection sees the $6,000 bill about to
land. It also raised Midland's June 2027 step from $3,136.69 to $3,230.92, because the Jan 2028
bill is inside its projection window.

| From | Midland | | OKC |
|---|---|---|---|
| today | $2,318.72 | Nov 2026 | $2,691.97 |
| Nov 2026 | $2,289.97 | | |
| Jun 2027 | **$3,230.92** | Dec 2027 | **$3,674.74** |
| Jun 2028 | $2,769.55 | Dec 2028 | $3,211.98 |

`midEscrowPlan()` walks the account month by month: deposits in, insurance out each May, the
tax bill out each January, and an annual analysis every June that resets the monthly escrow to
the next 12 months of disbursements over 12 and spreads any shortage against a 2-month cushion
over the following year. The resulting payment steps:

| From | Payment | Why |
|---|---|---|
| today | $2,318.72 | |
| Nov 2026 | $2,289.97 | PMI drops off (>20% equity — **needs a written request**) |
| **Jun 2027** | **$3,136.69** | first full-house tax bill, +$846.72, incl. **$389.82/mo shortage** |
| Jun 2028 | $2,764.50 | shortage cleared, −$372.19 |
| Jun 2029 | $2,780.17 | appraisal drift |
| Jun 2030 | $2,796.30 | |

`MID_ESC_START` is anchored to a real statement: $1,135.33 on 2026-09-02, which is *after* the
Sept 1 draft posted, so the walk begins one deposit earlier at $977.26. Change one and the
other must move with it.

#### The escrow closes with the loan — the bills do not

⚠️ **A mortgage retiring does not retire the house.** When the last payment posts the servicer
closes the escrow, refunds the credit balance, and stops paying the tax and insurance — which
become direct bills to you. Modelling only the loan meant the model quietly **stopped charging
Midland property tax and insurance from Aug 2049**, the month the PennyMac loan retires. In a
never-sold 30-year run that is **$88,835 of tax and $9,303 of insurance never charged**. OKC has
the same shape from Oct 2056; almost nothing lands inside the present horizon, but it would at
any horizon past 2057.

`postPayoffBills(cfg)` emits the refund plus a direct tax and insurance bill each year after the
final draft, for both homes, off the same config shape `escrowPlan` uses.

⚠️ **`retired` must be asked of the loan, never inferred from the dates.** Both schedules are
cut off at `TM()`, so at a short horizon the last row is just where the window ends with the
balance still owing. Testing `lastDate < T1` treated that as a payoff and billed the OKC tax
twice in the final year — $6,556 of phantom expense on the 5-year view. Midland asks
`balAfter <= 0`; OKC asks whether it reached its 360th payment.

⚠️ The same refund is **not** a deduction against `midTaxOwed` in `netWorth`. Once the account
closes, the balance is refunded into cash and counted there; still netting it against next
January's bill counts it twice ($8,236).

The renting-then-buying branch needs none of this: 360 payments starting from any purchase date
past 2027 retire after 2057, outside every horizon.

**The account is underwater from Jan 2027 to Feb 2028 — 10 drafts, bottoming at −$3,447.85.**
A credit balance is refunded ~30 days after payoff, but a **deficiency is added to the payoff
quote and comes out of the proceeds at closing**. Guarding the refund on `escBal>0` and doing
nothing else silently dropped that, which made a mid-2027 sale look ~$3,400 cheaper than it is.
What a sale actually costs at the table:

| Sale | Prorated tax | Escrow | Net |
|---|---|---|---|
| Oct 30 2026 | −$3,751.17 | +$1,293.40 refund | **−$2,457.77** |
| Feb 1 2027 | −$530.46 | −$2,751.13 deficiency | **−$3,281.59** |
| Jun 1 2027 | −$2,519.70 | −$3,447.85 deficiency | **−$5,967.55** |
| Jun 1 2028 | −$2,605.23 | +$1,230.04 refund | **−$1,375.19** |

**The bill is charged for the whole calendar year you owned it, not from `T0`.** The projection
starting 2026-08-14 does not change the fact that the full 2026 bill arrives on Feb 1, 2027 —
prorating to the window start would drop $2,785.52 of tax that is genuinely paid inside it. On a
sale it prorates Jan 1 -> closing. The year divisor is `nDays(ys,ye)+1`, not a hardcoded 365,
or 2028 is overcharged $17 for being a leap year.

Hold-forever posts four bills totalling **$23,220.51**. The **2030 bill is due Jan 31, 2031 and
falls outside `T1`**, so `E()` drops it — correct for a cash projection, but it leaves a
**$6,611.64** unpaid liability that the net-worth tile subtracts.

### Gain, recapture and capital gains (rules 14-15)

**Ordering matters.** The gain calculation needs `sellerCost`, which is not known until the
`if(sale){…}` block, so recapture is computed *there* and only declared above it.

```
realized = price - sellerCost
gain     = realized - (MID_BASIS - recapDep)      // depreciation LOWERS your basis
recapTax = min(recapDep, max(0, gain)) x rate     // capped at the actual gain
cgTax    = max(0, gain - recapDep) x 19.75%       // only once Sec.121 has expired
```

**Recapture is capped at the gain**, so a sale at a loss owes none — previously a $330k sale
still billed $11,035 while $82,659 underwater.

Note the counter-intuitive part: because depreciation cuts the adjusted basis, a sale can show
an *economic* loss and a *taxable* gain at once. Selling at $420,000 against a $425,000 cost is
a $5,000 loss, but after 6 months' depreciation the basis is $418,818, so $1,182 is taxable —
**$351.59**, not zero. The break-even is `MID_BASIS - recapDep`.

`SEC121_LAST = '2029-08-01'` (move-out Aug 1 2026 + 3 years). Sec.121 **never shelters
recapture**, only the excess above it — worth about $3,700 at 3%/yr appreciation. Do not let it
drive timing.

### Suspended passive losses (rule 22)

The model deducted depreciation every year, let the year net a loss, charged no tax — and then
**discarded the loss** while still recapturing the full depreciation at sale. That taxes one
side of the same coin.

At this income the $25,000 special allowance is fully phased out (it tapers to zero between
$100k and $150k MAGI), so a rental loss is a **suspended passive loss**: no benefit in the
year it arises, carried until disposal. **IRC 469(g)** then releases every suspended loss in
full when the activity is disposed of in a taxable sale, deductible against any income.

`suspendedLoss` accumulates in the loss branch and is released in the sale block as a
**negative** `addTax` entry, so it appears inside the same annual settlement:

```
Taxes — 2029 return (IRS balance $5,000.00
                     + depreciation recapture (30 mo, $30,909.09 @ 29.75%) $7,795.46
                     + suspended passive losses released ($8,382.10) -$2,409.85)
```

| Term | Suspended loss | Recapture | Released credit | Net at sale |
|---|---|---|---|---|
| 9 mo | $2,525.67 | $0 | +$726.13 | **+$726.13** |
| 18 mo | $5,130.59 | −$477.87 | +$1,475.04 | +$997.17 |
| 30 mo | $8,382.10 | −$7,795.46 | +$2,409.85 | −$5,385.61 |

`addTax` now accepts negatives, since a credit is a legitimate line on a return. The net-worth
`deferred` figure nets the release too — the hypothetical sale that justifies valuing the house
net of selling costs would release the losses as surely as it triggers the recapture.

**Not released without a sale.** Hold the house and the losses stay suspended, which is correct.

### One tax settlement per year (rule 21)

Tax used to arrive as 2-3 scattered lines a year — the $5,000 IRS balance on Mar 19, rental
income tax on Apr 15, and recapture plus capital gains on Apr 15 of the year after a sale.
Everything owed on one year's return now settles as **one line on the following April 15**,
with every component named:

```
Taxes — 2029 return (IRS balance $5,000.00 + rental income ($3,558.23 net) $1,022.99
                     + depreciation recapture (33 mo, $34,000.00 @ 29.75%) $9,649.43)
```

`addTax(taxYear, label, amount)` collects into `TAXDUE`; the bundle is emitted **last in
`buildEvents`**, because contributions arrive from three places and the sale block is the
latest of them. Emit it earlier — as the first attempt did — and the rental and recapture
amounts are silently missing while the IRS line still appears, which looks like a working
feature. The stray-line count in the test is what catches that.

The `$5,000` moved from **Mar 19 to Apr 15**, so it is now a tax-year label rather than a
payment date: `addTax(y-1, …)` inside the `YEARS_AHEAD` loop keeps the same payment *years*.

⚠️ A template literal is evaluated **before** the call that would reject it. `addTax` ignores a
zero amount, but `` `… @ ${rent.rate}%` `` still threw on a no-rent scenario. Guard the call,
not just the amount.

A 2030 rental profit's tax would fall due April 2031, outside `T1`, so `E()` drops it — the
same window edge as the 2030 property-tax bill.

### Rent escalation (rule 23)

Rent steps up **on each lease anniversary**, `Math.floor(i/12)` on the payment index — so a
term under 13 months never sees one, and at the 6-month default the setting is **provably
inert** (0%, 3% and 10% all produce identical output).

`rentRows` replaced the four flat scalars: one row per payment carrying its own escalated rent,
vacancy, collected, management and maintenance. **The ledger and the Schedule E read the same
rows**, so an escalating rent cannot show one figure in the table and another in the tax
calculation — which is exactly what parallel scalars would have allowed.

Maintenance is a flat annual reserve and deliberately does **not** step; only the
percentage-based costs follow the rent.

| Term | 0% | 3% | 5% |
|---|---|---|---|
| 18 mo gross | $59,400.00 | $59,994.00 | $60,390.00 |
| 30 mo gross | $99,000.00 | **$101,393.82** | $103,009.50 |

Payment 12 is $3,300.00 and payment 13 is $3,399.00 — the step lands on the anniversary, not on
a calendar year, and the ledger label says `· escalated 3%/yr` once it applies.

### Landlord costs (rule 20)

Three inputs, defaulting to **10% management, 1 month/yr vacancy, $2,500/yr maintenance**. Emitted as **one combined monthly line** — three separate ones would
add 90 rows to a 30-month tenancy — with the split spelled out in the label.

```
vacancy   = rent x vacancyMo/12          (uncollected rent, NOT a deduction)
collected = rent - vacancy
mgmt      = collected x mgmtPct          (8% of what is actually collected)
maint     = maintAnnual/12
```

Reproduces the reference exactly: $3,000 rent at 8% / 1 mo / $2,500 nets **$2,321.67/mo**.

**Vacancy is not an expense.** It is rent you never receive, so it reduces the Schedule E
*income* line; management and maintenance are deductions on top of it. Getting that backwards
double-counts the vacancy.

**These flip the rental from a taxable profit to a paper loss at every term:**

| Term | Gross | Landlord costs | Schedule E | Income tax |
|---|---|---|---|---|
| 9 mo | $32,400 | −$6,950.97 | **−$2,525.67** | $0 (was $1,272) |
| 18 mo | $64,800 | −$13,901.94 | −$5,130.59 | $0 (was $2,522) |
| 30 mo | $108,000 | −$23,169.90 | −$8,382.10 | $0 (was $4,252) |

⚠️ **Two falsy-zero traps, both real bugs that shipped.** `+value || fallback` and
`(!isFinite(n) || !n) ? fallback : …` both treat a deliberate **0** as absent, so typing 0 into
a rate or a maintenance field silently reapplied the default. `numOr()` and `digits()` now test
for an **empty string** instead. Any new numeric input must do the same.

⚠️ **Seed every key in an accumulator.** The Schedule E `add()` initialiser was missing `mgmt`
and `maint`, so `undefined += v` produced `NaN` — and the `(a.mgmt||0)` guard turned that NaN
into a silent **zero**, dropping both deductions from the net. The guard hid the bug rather
than preventing it; the fix is a complete `BLANK` template and no `||0`.

### Rental income tax (rule 19)

**Property tax during a tenancy is already paid — it is inside the PennyMac escrow**, which is
why no separate tax cheque appears while the house is rented. That is correct, not a gap.

What *was* missing is tax on the rental **profit**. Schedule E:

```
rent − mortgage interest − property tax − insurance − depreciation
```

At **$3,600/mo this is a profit, not the paper loss** a lower rent produces — the earlier
assumption that it "runs a small loss worth under $1,000/yr" was simply wrong at this rent:

| Term | Gross rent | Net income | Tax @ 28.75% |
|---|---|---|---|
| 9 mo | $32,400 | $4,425.30 | **$1,272** |
| 18 mo | $64,800 | $8,771.35 | $2,522 |
| 30 mo | $108,000 | $14,789 | **$4,252** |
| 36 mo | $129,600 | $17,905.41 | $5,148 |

Computed and posted **per calendar year**, due the following April 15. Only profitable years
are taxed: passive losses are suspended above ~$150k MAGI and released at sale, so carrying a
loss forward would overstate the benefit.

The depreciation deducted here is the **same figure recaptured at sale** — deduct it annually,
pay it back on the way out. `RENT_TAX_DEFAULT = 28.75` (24% federal + 4.75% Oklahoma, single
filer at this income); use 26.75 if filing jointly puts you in the 22% bracket.

⚠️ **`+value || fallback` swallows a deliberate `0`.** Both tax-rate inputs had this: typing 0
silently reapplied the default. Use `numOr(id, fallback)`, which checks for an empty string
rather than falsiness. Any future rate input must do the same.

### Price follows the date (rule 16)

Price and timing are not independent — the price *is* the date. `priceOn(d)` grows
`MID_VALUE_TODAY` at `MID_APPREC` from `MID_VALUE_DATE`; both are inputs. A manual override
behind `#priceover` remains for pricing a real offer. With no sale set, the house is valued at
`priceOn(T1)`.

This is what makes the relocation cliff legible: with the price pinned to the date you can see
that selling Nov 2027 needs **16.17%/yr** appreciation to beat selling May 2027.

### Interest on the balance (rule 17)

`buildSeries` takes an `apy` and credits `bal*rate/365` **before** the day's events, guarded on
`bal>0` so an overdraft never pays you. Shipped at **0**, which reproduces the old behaviour
exactly; 4% is worth ~$28,000 over the window. It is not neutral — it favours whichever
scenario holds cash longest, so leaving it out quietly biased the model *against* renting.

### Net worth, not just cash (rule 18)

Cash alone ranks scenarios by how long you avoided owning anything: a mortgage payment leaves
the account and the equity it buys never comes back in. `netWorth()` adds OKC equity (amortised
at 5.99%, appreciated 3%/yr, net of 7% selling costs) and Midland equity when unsold, then
subtracts three things the balance never sees:

- **the car loan** — $5,058 still owed on Dec 31 2030 when no sale ever pays it off
- **the unpaid 2030 property tax** — the hole rule 13 leaves
- **`deferred`** — the subtle one. Valuing an unsold house *net of selling costs* implies a
  sale, so you must also charge the recapture and capital gains that sale would trigger. Omit
  it and never-sell scenarios are overstated.

### Three horizons (rule 25)

`T1` is a **variable**, not a constant. `h30` ends 2056-12-31, which lands on the **360th OKC
mortgage payment** — the long view covers exactly the life of the loan.

⚠️ **Anything that used to end at a literal `'2030-12'` must derive from `TM()`.** Miss one and
that item silently stops paying partway through the horizon while everything else continues —
the same failure `mortgageSchedule` and the renter utilities each had. `yearsAhead()`,
`nhDates()`, `seasonal(...,YR(T1))` and every `monthly(...)` range now key off `T1`.

⚠️ **Term caps must outrun the horizon.** `#rentterm` and `#hterm` were capped at 60 months,
sized for a 5-year model. With a 30-year horizon that silently clamps a long tenancy back inside
the window and the sale reappears — the input reads 400 and the model uses 60. Both are 600 now.

The **view list is ordered widest-first** (`h30, h15, h5, 2026, …`) so stepping *back* from the
default 2026 walks 5 years → 15 → 30, progressively zooming out, and the dropdown reads the same
way top to bottom. `VIEW` defaults to `'2026'` with `HORIZON` at `h5`.

⚠️ **A loan must stop at its TERM, not at `T1`.** Running to the horizon billed the OKC mortgage
**362 times** — two payments after it retires — and would have amortised Midland's past zero.
Both now stop: OKC capped at `NH_TERM_PMTS = 360` (last draft 2056-10), Midland breaking when
the balance clears (276 payments, 2049-08) with a short final payment. This is invisible at 5
years and obvious at 30.

**Rendering is thinned, the data is not.** 11k daily points across three paths is ~66k path
commands. `keep(i)` samples the drawing to ~1,500 points while `X(i)` stays indexed on the full
array, so hit-testing and the readout remain exact. Renders in under a millisecond at every
horizon.

Axis scaling had to become adaptive too: a fixed 20k/40k y-step stacks 80 labels into a column
at $3.2M, and "always label January" collides 31 times over 30 years. The step is now a
nice-number fit to ~6 gridlines, the **floor sits on the data** rather than snapping to the step
(which wasted a third of the chart), and past 36 months the axis switches to year-only labels.

**Income assumptions over 30 years.** Pay rises 3%/yr throughout — which is **flat in real
terms**, since inflation is also 3%. The 2056 figure of $217,958 net is $89,795 in 2026 dollars,
essentially 2027's $92,486. The bonus and the $5,000 IRS balance stay flat in *nominal* terms, so
both shrink in real terms. **No retirement is modelled** — that is the single biggest limitation
of the 30-year view.

Real growth in the long views comes mostly from a **fixed P&I against 3% wage inflation**: the
mortgage shrinks in real terms every year it is held.

### Buying power (rule 24)

`realAt(v,d)` deflates any balance to **`T0` dollars**, and a dashed `--s7` line on the chart
plots the whole series that way. It exists to answer one question — *am I growing faster than
inflation?* — which the nominal line cannot: rising means yes, flat means treading water.

`INFL_PCT` is now an input and drives **both** cost inflation and the deflator, deliberately —
one inflation assumption, not two. A consequence worth knowing: changing it moves the *nominal*
line too, because costs stop or start inflating. At 0% the two lines coincide exactly, which is
the check that the deflator is wired correctly.

The real line is included in the y-scale (`bmin`), or it clips below the axis. Draw order is
**band → real → nominal**, so blue paints over purple where they cross and the fill sits behind
both. The band runs forward along the nominal path then back along the real one with the step
corners mirrored (`L x,RY(i-1)` then `L x-1,RY(i-1)`), closed with `Z` — get the mirroring wrong
and the fill shears across the chart rather than hugging the two lines.

### Opportunity cost — the break-even ROI (rule 26)

Answers *"what would I have to earn elsewhere to beat keeping the Midland house and renting it
out?"* The answer is the **indifference rate**: run the same engine on two scenarios and find
the rate at which their net worth at `T1` is identical. Beat it and selling wins.

| Horizon | Keep & rent | Sell now & invest @7% | Break-even |
|---|---|---|---|
| 5 years  | $541,460    | $501,853    | **19.7%** |
| 15 years | $2,823,171  | $2,582,605  | **13.3%** |
| 30 years | $11,622,772 | $10,647,185 | **11.5%** |

Both sides run the **real engine**, so the relo window, the loss credit, recapture, the §121
expiry, escrow and landlord costs are all priced in for free and can never drift out of sync
with a parallel calculation. That is the whole design argument for doing it this way.

⚠️ **The same rate must be applied to both scenarios' cash.** Comparing a house against an
index fund while the house's spare cash earns 0% is not a comparison, it is a rigged one.

⚠️ **The keep side must stay rented for the whole window.** Passing the configured 36-month
term meant *"rent it 3 years, then hold an empty house for 27 paying every bill with no
income"* — a scenario nobody is choosing. It inverted the answer: the panel reported *selling
wins outright* where the truth is a break-even of 11.5%. `oppMonths` extends the term to `T1`.

⚠️ **`buildEvents` does not depend on the rate — only the daily walk does.** So each scenario's
events are built **once** and re-walked per candidate rate (`oppWalk`). That turns a 24-step
bisection from ~48 full engine runs into two, and is the only reason this sits in `render()` at
a 30-year horizon instead of behind a button. `oppWalk` is verified to match `buildSeries`
**to the cent** at 0/3/7/15/30%.

⚠️ **Bisection is only valid because keep-minus-sell is monotonically decreasing in the rate**
(the selling side holds more cash earlier, so every extra point is worth more to it).
Monotonicity is asserted by sampling 13 points across the range — on a non-monotone difference
bisection would land on an arbitrary root. `verdict` is `'sell'` when selling wins even at 0%
and `'keep'` when keeping still wins at `OPP_MAX` (60%); neither invents a number.

⚠️ **`oppAcrossHorizons` swaps the global `T1`** and restores it in a `finally`. `T1` is read by
`TM()`, every schedule and every event builder, so leaving it pointing at the wrong horizon
would silently corrupt every later render, not just that one. The panel body is filled **only
when the `<details>` is open**, because the sweep is six event builds.

The sensitivity to Midland appreciation is genuinely **flat** (11.33% at 0%/yr → 12.87% at
7%/yr) and this is not a bug. Higher appreciation raises the sale value but also the property
tax and the recapture/CGT bill, and by 30 years salaried savings dominate terminal net worth in
both scenarios. It was checked precisely because it looked wrong.

⚠️ **`--s2` is the sell-Midland-now line** on the chart, drawn first so both the real and
nominal lines paint over it, and folded into `bmin`/`bmax` or it draws off the top.

⚠️⚠️ **The chart line runs at `apy`, NEVER at `OPP_ROI`.** Two balance lines on one chart at
different compounding rates are not comparable, and this was shipped wrong once: with the
default cash APY of 0% against a 7% alternative, the sell line ended at $9,440,855 against the
blue line's $3,259,869 — **2.90x higher, and essentially all of that gap was the rate rather
than the house decision.** It read as "selling makes you three times richer." Forcing both to
the same rate puts them within $10k of each other (1.00x) at 0/0, 4/7 and 7/7.

### Two-tier interest (rule 27)

The fix for that whole class of bug. `accrue(bal, r)` splits the balance:

```
liquid = min(bal, r.floor)      -> earns r.cash     (bank rate)
surplus = bal - liquid          -> earns r.invest   (investment rate)
```

There is now **ONE rate spec** — `RATES = {cash:apy, invest:OPP_ROI, floor:LIQ_FLOOR}` — built
once in `render()` and handed to the main projection, both comparison scenarios and the chart
line alike. Two surfaces can no longer disagree about what cash earns, because there is only one
rule. `floor = 0` reproduces the old single-rate behaviour exactly (break-even 11.53% at 30
years, matching the pre-two-tier figure to the basis point), which is the regression check.

Why a floor at all: cash below it is **operating money** — it covers the cash-flow trough and
the dated obligations (car payoff, the $27k to the fiancée, the annual IRS payment, the escrow
shortage), none of which belong in equities. Only the surplus is genuinely long-horizon.

⚠️ **The floor protects near-term cash-flow planning.** The Oct 2026 trough sits *below* the
floor, so the investment rate cannot touch it: it moved only −$9,215.16 → −$8,702.03, and that
$513 is two weeks of yield on the pre-closing balance. Had the rate applied to the whole
balance, the projection you use to answer *"will I clear Oct 1?"* would have been inflated by
market returns on money you cannot spend.

Break-even rises with the floor, as it must — a bigger floor leaves less earning the investment
rate, so it takes a higher rate to catch up:

| Floor | Break-even (30y) |
|---|---|
| $0 | 11.53% |
| $25,000 (default) | 11.60% |
| $100,000 | 11.97% |
| $500,000 | 16.56% |
| $5,000,000 | keeping wins at any rate |

⚠️ **Re-verified after the refactor, because the two-tier rule could have introduced a plateau**
(a flat stretch where the rate has no effect would make the root non-unique and bisection
meaningless). It is **strictly** monotone at all three horizons, 13 sample points, zero flat
steps, and `oppWalk` still matches `buildSeries` to the cent at 0/3/7/15/30%.

⚠️ **`--s8` (magenta) is the sell-Midland-now line, and it is drawn only when the panel is
open** (`oppShown`). `oppVD` is `[]` otherwise, so the `isFinite` guards on `oLo`/`oHi` are
load-bearing — without them an absent line poisons the y-scale with `Infinity`.

⚠️ **The floor INFLATES.** It is stated in `T0` dollars and scaled by the same `inflAt(d)` the
costs use — $25,000 today is **$58,914 by 2056**. A buffer that stayed nominally flat would
quietly shrink to a fraction of a month's bills over a 30-year window while the model claimed it
was still a cushion. One inflation assumption for the whole model, not two. Because the floor
grows, a large floor bites harder than it used to: at $500,000 the 30-year break-even is 19.2%
(it was 16.56% when the floor was flat).

### Today in the transactions table

The chart marks today with a vertical rule; the table now does too, in the same `--ink-2` ink so
the two read as one marker in two places.

- Rows dated today get `.today` — a tint, a left accent bar, and a **TODAY** pill.
- When today falls in the displayed month but has **no line of its own**, a `.todaymark` divider
  is slotted where it belongs in the descending order: after everything still to come, before
  everything already past.

⚠️ `details td` has **zero left padding**, so an `inset` box-shadow accent lands on top of the
date text. Today's first cell is indented 9px past the bar.

### Sunset: rent-instead-of-buy (rule 33)

The OKC purchase is committed, so the whole alternative-housing scenario is gone: the sheet
group, the `hown`/`hbuy` switches, `MYRENT_DEFAULT`, `BUY_DEFAULT`, `BUY_LEAD_MONTHS`, the
Housing tile, the `hwarn` block, the your-own-rent and later-purchase event blocks, and the
renter-utilities run. `readHome()` is now `() => ({own:true})` — kept as a function returning a
constant so `home` still threads through the engine and `netWorth` without churning every
signature. `owning`, `myEnd`, `buyDate` and `ownedFrom` collapse to constants in `buildEvents`,
and `myRentTotal`/`buyCC` stay in the return shape as zeros because the tiles read them.

Renting the Midland home is committed too, so the `renton` switch is gone and `readRent()`
always returns a tenancy. The engine keeps its `rent === null` guards: the opportunity-cost
comparison still needs a no-tenant scenario internally (`oppScenario(SALE_FLOOR, null, home)`).

### Entering the tenancy and the sale (rule 34)

**Term in months became two dates.** The reader gives *Rent starts* and *Rent through*;
`monthsBetween()` derives the month count the engine wants. Asking for a term in months made
the reader do that arithmetic in their head against a start date on the 2nd.

**`SALE_AUTO` is now a visible control** rather than hidden state inferred from typing: *As soon
as the tenant leaves* (the field is **disabled**, because the date is derived) versus *On a date
I choose* (the field unlocks). The mode also drives the note under it — "clear the closing date"
is advice the reader cannot act on while the field is disabled.

⚠️ **The lease-length hints live in `syncSaleDate`, not `render()`.** They are the feedback for
the field being typed into, so batching them behind Apply left them contradicting the dates on
screen — the hint read "12 months · 11 full payments" while the field said a 24-month lease.
Anything that annotates a field the reader is editing belongs on the live path.

### The signed lease (rule 32)

**A tenant is confirmed: 12 months from Oct 2 2026**, and they **assume the Vivint contract**.
`RENT_DEFAULT` is now `{start:'2026-10-02', months:12}`.

⚠️ **A mid-month move-in needs PRORATION**, and adding one without it loses money silently.
`rentSchedule` used to take the first 1st *on or after* the start and bill `months` payments from
there — so a 12-month lease starting the 2nd billed 12 payments from **Nov 1**, giving the tenant
October free and running the lease to Nov 2027 instead of Oct. It now emits a prorated payment on
the move-in day (30/31 of October = **$3,193.55**) plus `months - 1` full payments, and `end` is
measured from the **start date**, not from the first full payment.

- The prorated row carries `i = -1` so it never shifts the 12-month escalation boundary, and it
  is labelled by days rather than numbered.
- `rented(d)` keys off `rent.start`, **not** `rentDates[0]` — the tenant is in the house from
  move-in, and that gates the utilities, Vivint and the relo reimbursement.
- Depreciation counts the partial month (`rentDates.length + pro.frac`).

⚠️ **The tenant assuming Vivint is not the same as the tenant merely being in the house.** The
drafts were already suppressed by `!rented(d)`, but that only pauses them for the tenancy and
still charges a buyout at the sale. On handover the contract is **not yours at all**:
`vivHandover = rent.start` stops the drafts for good, and `buyout` is suppressed entirely,
because the contract transferred rather than being settled. Two drafts remain (Aug 22, Sep 22)
and the buyout fee is gone.

⚠️⚠️ **Vacancy is charged at TURNOVER, never as a monthly accrual.** It used to be billed every
month as `amt * vacancyMo/12` — $275/mo against a unit with a *signed* tenant in it, $3,025 over
a 12-month lease that cannot have a vacant day. `turnovers` now emits one lump at each 12-month
boundary **inside** the term; the final boundary is not one, because the tenancy simply ends there
(sale, or the window closing) and there is nothing to re-let. A 12-month lease therefore has **no
vacancy cost at all**, which is the truth. A 60-month term gets four.

Two consequences worth knowing: rows keep a `vac` field (now always 0) so every downstream
consumer is unchanged, and **management fees rise**, because `coll` is now the full rent — the
company takes 10% of what is actually collected, and with no vacancy that is all of it ($330/mo
against $302.50 before). Turnover vacancy is *uncollected rent*, not a deduction, so it reduces
its own year's Schedule E income rather than being expensed.

⚠️ **Maintenance ramps, it is not flat.** `maintPerYear(rent,d)` holds the reserve you set while
the house is under builder warranty (`MAINT_WARRANTY_END`, ~May 2027, two years from the mid-May
2025 build), then interpolates linearly to **1% of the house's value** over `MAINT_RAMP_YEARS`
(10). Because the target tracks `priceOn(d)`, it keeps climbing with the house:

| | 2026 | 2029 | 2032 | 2037 | 2056 |
|---|---|---|---|---|---|
| reserve/yr | $1,200 | $1,739 | $2,922 | $5,770 | $9,995 |

A flat $1,200 was right for this lease and badly wrong for a 30-year hold — the old figure
understated 2056 maintenance by a factor of eight.

**The management company takes two separate things**, and they are modelled separately:

| | |
|---|---|
| Placement fee | `leasePct` (50%) of **one full month's rent** = $1,650, **once**, on the move-in day |
| Management | `mgmtPct` (10%) of collected rent, **every month** |

⚠️ The placement fee is a share of a **full** month's rent, not of the prorated move-in payment
— it prices the tenant placement, not that month's income. It is charged **once at `rent.start`**,
not per year, and it is a deductible management expense, so it joins the Schedule E `mgmt`
bucket in the year it is paid. It also has to be added to `rentCostTotal` explicitly, since that
figure is otherwise a sum over the monthly rows and the fee is not one of them.

⚠️⚠️ **The lease pushes the earliest sale past the relo deadline.** It ends 2027-10-02; the relo
window closes 2027-07-20. Selling at the lease end costs **$32,523.21** in seller costs and voids
the loss credit — **$27,086.11 less in hand** than a sale inside the window
($73,302.92 vs $100,389.03). Unavoidable with a 12-month tenancy, but it should be a known
trade, not a surprise.

### The wire date is not the closing date

⚠️ **`CLOSING_DATE` and `WIRE_DATE` are deliberately separate constants.** `CLOSING_DATE`
(Sept 18) sets ownership, the loan start, the 13 days of prepaid interest to month end, the
escrow and the Nov 1 first payment. `WIRE_DATE` (Sept 17) is *only* when the cash physically
leaves the account. Moving the wire earlier must **not** drag the loan terms with it — if the
closing itself ever moves, `NH_PREPAID_DAYS` has to move with it (Sept 18 → 13 days; a Sept 17
closing would be 14, about $67.85 more).

**The Sept 18 paycheck landed on the 16th**, two days early. Only that one cheque moved; the
biweekly run from Oct 2 is untouched.

⚠️ Those two changes interact, and the "Before the wire" tile had **both** assumptions baked in:
it read the Sept 17 balance and *added `PAY10` by hand*, because the cheque used to arrive the
same morning as the wire. With the cheque now landing on the 16th it is already in the balance,
so the manual addition would have double-counted it. The tile is now simply the balance at the
close of the day before `WIRE_DATE`, and its caption is derived rather than hardcoded.

### Cash to close is anchored to the lender's figure

`nhCashToClose()` must equal **$109,504.92 at 22% down** — the figure from the lender, which is
authoritative over the component build-up. `RELO_SHORTFALL` (72.32) is the line that closes the
gap, entered separately so the donut still reconciles and the shortfall stays visible.

⚠️ **It must not scale with `DOWN_PCT`.** A relo shortfall is a fixed dollar amount, not a share
of the price. Verified: 72.32 flat at 15% / 22% / 30% down, while the total moves
$72,491.06 / $109,504.92 / $151,806.48.

⚠️ **Worth re-checking against an actual Closing Disclosure.** The component build-up was
already within **$72.32** of the stated figure, which does not match the description of the
relocation company covering materially less. Either the shortfall really is that small, or relo
dropped a larger itemised cost and something else in the build-up is too high by about the same
amount — the total is right either way, but the itemisation may not be.

### Correcting a reconcile (rule 31)

Reconciles used to be strictly append-only — `POST` returned **409 "already reconciled and
cannot be changed"**, there was no `PUT`/`PATCH`/`DELETE`, and `eligibleDates()` only offered
*unreconciled* days, so a mistyped entry was unfixable without shell access to the Railway
volume. A typo is not history; it is a typo.

`PUT /api/reconciles` corrects one. **Immutability is preserved in spirit, not abandoned:** the
previous value is written to a new `reconcile_edits` table *before* the row is updated, so
nothing changes silently. A separate table means **no migration of `reconciles`** — existing
rows are untouched, which matters because the production data is live on a volume.

Guards, all verified against a running server: wrong passcode → 401 · unknown date → 404
("nothing to correct") · identical figure → 400 (no empty audit rows) · `POST` over an existing
date still → 409, so the append-only path is unchanged.

The sheet has two modes (`RECMODE`). **Correct** lists only reconciled days and **prefills the
variance the reader originally typed**, not the stored balance — the balance is derived
(`actual = projected + variance`), and the variance is the number they actually entered and are
correcting. It also requires a reason, kept in the audit log.

⚠️⚠️ **`refreshTrigger()` must account for corrections too.** It hid the reconcile button
whenever `eligibleDates()` was empty — correct only while the sheet could *only add* entries.
Once corrections exist, that hides the sheet at exactly the moment a typo needs fixing, and
anyone reconciling daily eventually has no eligible days and loses the button entirely. It now
hides only when there is nothing to add **and** nothing to correct. `fillForm()` also opens
straight into Correct mode when "New entry" would have an empty date list, and disables the
mode that has no dates.

⚠️ `/api/state` is **unauthenticated** and now returns `edits` alongside `reconciles`. Fine for
a single-user planner on an unguessable URL, but it means the whole reconciliation history is
readable by anyone with the link — worth knowing before sharing it.

### The past is not a projection (rule 30)

⚠️ **`accrue` returns 0 for any date before `TODAY_ISO`.** Days that have already happened are
history: their balance is whatever actually occurred, anchored by `START_BAL` and pinned by any
reconciles. Accruing a *projected* rate across them meant that changing an assumption silently
rewrote dollars already lived through — and already reconciled against. Before the fix, nudging
the cash APY moved the Aug 14 opening balance. Verified: every rate input (`cashapy`, `opproi`,
`liqfloor`, `inflpct`) now leaves 2026-08-14 / 08-25 / 09-05 / 09-15 **bit-identical** while
every future day still responds.

Rates are the only settings that reached backwards. Everything else — rent, price, down payment,
inflation on costs — only drives events dated in the future, so it was already safe.

⚠️ **`SALE_FLOOR` must BE today, not a date someone typed on the day they wrote the line.** It
was hardcoded to `'2026-09-15'` and had already drifted into the past, so the earliest allowed
sale — and the whole "sell now" comparison — were dated yesterday. Now
`TODAY_ISO > T0 ? TODAY_ISO : T0`, which also guarantees it can never precede the projection
start. **Audit the other hardcoded dates the same way**: `T0`, `FENCE_PAID` and the 2026-09-18
closing are genuine historical anchors and must NOT move, but anything meaning "now" must be
derived.

**The investment return defaults to 0%,** deliberately. The blue line is then a conservative
projection that assumes no market return at all, and real gains arrive through
**reconciliation** — where an account that grew shows up as lime-green positive variance and
rebases everything after it. Projecting 7% instead would bake an assumption into the line you
use for cash-flow planning. Raise it when you want to ask the opportunity-cost question; the
break-even panel solves for its own rate regardless and is unaffected by the default.

### Reading the comparison, and the live date preview

⚠️ **The comparison line's gap is not visible to the eye, and that is a scale problem, not a
bug.** On the 5-year view the y-axis spans $334,380 across 332px, so **1 pixel ≈ $1,007**. The
two lines end $2,472 apart — **2.5 pixels** — and read as perfectly aligned. The scrub tooltip
therefore spells the gap out (`"$323,206.34 if sold now · −$2,471.57 behind"`), shown only while
the panel is open, i.e. only when the line is on screen.

Worth recording, because it looks wrong and is not: **before the sale the sell-now line is well
ahead** (+$79,086 Sept 2026, +$51,769 Jan 2029, +$62,354 Sept 2029) — that is the early
compounding the reader expects. At the Oct 2029 sale the main line jumps $44,427 past it, and
from mid-2030 they run ~$2,400 apart. The two effects genuinely cancel over this window:

| | |
|---|---|
| proceeds selling now (Sep 2026) | $85,895 |
| proceeds selling later (Oct 2029) | $112,428 — **$26,533 more, three years later** |
| rent collected over the tenancy | $93,480 (before the mortgage it still pays) |

⚠️ And the usual misreading: **both lines earn the same investment rate** on cash above the
floor. The sell-now line's advantage is only holding *more cash earlier*, never being the only
one invested. Set the return to 0 and the paths separate sharply.

**`syncSaleDate(rent, home)` is split out of `render()`** so the sheet can keep the closing date
honest on **every keystroke** while the expensive recompute stays batched behind Apply. It does
DOM work only — no engine — and `render()` calls the same function, so the live preview and the
applied projection can never disagree about the date. `previewDates()` is the cheap wrapper the
sheet's listeners call.

⚠️ **Order matters in those listeners:** re-arm `SALE_AUTO` *before* previewing, or the preview
runs against the stale flag and has to be corrected by a second pass. The impossible-sale
warning is raised inside `syncSaleDate` (it needs no engine figures, so the reader sees it
immediately); `render()` owns only the relo-cost variant, which needs `sellerCost`.

### The scenario sheet (rule 29)

Four labelled groups, not one flat list of ~25 fields: **Selling the Midland home** ·
**Renting it out** · **Your own housing** · **Rates & assumptions**. Groups stack; each group's
`.grpbody` is the two-column grid on desktop, so fields pair up *inside* a group rather than the
whole sheet being one grid. `.wide` marks anything that must keep a full row.

Appreciation moved into **Rates & assumptions** — it is an assumption, not a property of the
sale — and pairs naturally with inflation there.

⚠️ **The switch hit area is the switch.** The `<label>` used to wrap the caption as well, making
a ~400px-wide target for a 38px control, so clicking the text toggled it. The caption is now a
sibling `<span>` in a `.swrow`, tied to the input by `aria-labelledby` so it is still announced.
Measured hit area: **48×32** (track + 5px padding, cancelled by a negative margin so the switch
still sits flush). All four switches verified to still toggle from the track.

⚠️ **`box-sizing:border-box` is required on the full-width inputs.** They carry 10px side padding
and a 1px border, so `width:100%` alone resolves to `100% + 22px` — invisible in a roomy desktop
column, but it pushed the whole sheet off the right edge of a phone. Verified no overflow at
360/390/768/1180.

⚠️⚠️ **Two mobile-only traps, neither reproducible in headless Chrome.**

**1. `width:100%` does not constrain a date input.** A grid or flex item defaults to
`min-width:auto`, so it refuses to shrink below the native control's intrinsic width — and on
iOS that control is wider than the field, so the dates hung over the card edge even with
`box-sizing:border-box` already set. The fix is `min-width:0` on the input **and** on every
ancestor that has to pass the constraint down (`.ctl`, `.grpbody > *`, `#rentfields > *`,
`#hfields > *`, `#hbuyfields > *`), plus `-webkit-appearance:none` and the
`::-webkit-date-and-time-value` / `::-webkit-datetime-edit` resets that stop iOS centring and
padding the value. Desktop Chrome renders date inputs far narrower, so none of this shows up in
a headless screenshot.

**2. iOS zooms the page when a focused control has `font-size < 16px`,** and the reader then has
to pinch back out. The controls were 14px. They are now 16px under `@media (max-width:759px)` —
applied to every control on the page, not just the sheet. ⚠️ Do **not** "fix" this with
`maximum-scale=1` or `user-scalable=no` on the viewport: it disables pinch-zoom for everybody
and is a real accessibility regression. 16px is the threshold, so 16px is the fix.

Field widths are deliberately uniform (`width:100%` on numbers, dates and `.moneyfld` alike). A
full-width box for `3` looks slightly empty, but mixed intrinsic widths — dates filling the
column, money fields at 115px, numbers at 92px — read as ragged, and alignment is what makes 25
fields scannable.

**The "never sold in window" switch is gone.** Clearing the closing date models it instead: an
empty value is falsy, so every `if(sale)` guard downstream already handled it, and the sheet
says so in a note. Verified — clearing the date drops the proceeds tile to `—` and moves net
worth.

### The sale date, the tenancy, and a switch that flipped itself

⚠️⚠️ **`.switch` needs `position:relative`, and it is load-bearing.** The hidden checkbox inside
each switch is `position:absolute`; with no positioned ancestor its containing block resolved to
`.modal`, which is `position:fixed` and **does not scroll**. The sheet's content scrolls and
that invisible 0×0 input stayed where it was, so after scrolling it could come to rest exactly
on top of another field — clicking that field then toggled the switch instead. This is what
made **"Rent it out" flip off while editing the rent term**. Verified contained at scroll
offsets 0/400/900/1500, and the input also now carries `pointer-events:none` so only the label
can ever activate it. All five switches still toggle from both the track and the label.

⚠️ **Never let `$sd.min` exceed `$sd.max`.** When the tenancy outruns the horizon the old code
set `min=2068-06-01` against `max=2030-12-31` — an impossible range that leaves the control
permanently invalid in a real browser. No sale is possible in that state anyway, so the range
collapses to `T1` and `disabled` plus the warning carry the meaning.

**`SALE_AUTO` replaced inferring intent from the value.** The sale date follows the end of the
tenancy **in both directions** while `SALE_AUTO` holds; typing a date opts out, and editing the
lease (term or start, or the rent toggle) re-arms it — changing when the tenant leaves is a
statement about when the house can sell.

⚠️ The old test was `$sd.value===LAST_SALE_MIN`, and it broke silently: **any** render where the
target fell outside the horizon left the value unequal to the floor, so the date stopped
tracking permanently. That is why 300 → 100 months appeared to do nothing. With `SALE_AUTO`,
widening the horizon re-derives the date from `saleMin` on the very next render.

**A 5-year window with a long lease genuinely cannot sell**, and 300 → 100 months still moves
nothing there — the tenant is in place until 2035 either way. That is correct, so the warning now
names the blocking date rather than stating a generality: *"The tenant is in place until Oct 1,
2051, past the end of this window (Dec 31, 2030) — so no sale can close inside it."*

### Batched edits and the spinner (rule 28)

The sheet no longer recomputes on every keystroke. Edits call `markDirty()`; the recompute runs
once, on apply, behind a spinner. **Why** — measured work per render, at the 30-year horizon:

| Render | `buildEvents` | day-steps |
|---|---|---|
| cold, panel closed | 3 | 610,390 |
| cold, panel **open** | 15 | **1,610,660** |
| cached (view switch) | 1 | 11,098 |
| cached, panel open | 1 | 11,098 |

Every keystroke used to pay the cold cost. Two things fix it, and both were needed:

**`OPPC`, the comparison memo.** Keyed on everything the comparison actually depends on — and
**`VIEW` is deliberately not in the key**, because switching the chart window cannot change a
break-even rate. `OPPC.filled` memoises the panel body separately; its exits table alone is six
`buildEvents`. A cached render is now **one** `buildEvents` and one series walk, the floor.

**Batching.** `applyChanges(close)` is wired to the apply button, the close button, the backdrop
and Escape, so a pending edit can never be silently lost. The field-visibility toggles still fire
instantly — only the recompute waits.

⚠️ **Two `requestAnimationFrame`s, not one.** The first gets the spinner into the DOM, the second
guarantees it has actually *painted* before the blocking work starts. With a single rAF the
browser can coalesce both and the spinner never appears at all.

⚠️ **Timing this in headless Chrome does not work.** `performance.now()` is clamped to 0, and
`Date.now()` does not advance during synchronous JS under `--virtual-time-budget` — so a
busy-wait loop (`while(Date.now()-t0 < 300)`) **never terminates**, hangs the browser, and the
orphaned processes then block every later headless run until they are killed. Count work
(`buildEvents` calls, day-steps) instead; it is deterministic and it is what actually changed.
Also: `timeout` does not exist on macOS — a run wrapped in it never starts, and the empty output
looks exactly like a page crash.

**What the model still cannot see.** The investment rate is applied as a *smooth daily accrual*.
Real returns are volatile, and a drawdown timed against one of the dated obligations forces
selling at the bottom. Nothing here shows that sequence risk, and it is the single largest
omission in the break-even figure.

⚠️ **`--s7` is reserved for buying power.** Reconciled variance uses its own pair instead —
**`--vpos`** (lime) when the day came in over projection and **`--vneg`** (light red) when it
came in short, applied in the table rows (`.vp`/`.vn`), the timeline tooltip and the modal's
recorded list. Both are lifted in dark mode; a single colour could not show the sign.

**Event markers thin out as the window widens.** A `$800` bar draws hundreds of triangles
across 53 months and buries the line. Two limits now apply together:

- a **span floor** — `$800` up to 12 months, `$2,500` to 30, `$6,000` beyond
- a **count cap** — 18 markers on desktop, 10 on mobile, by taking the (CAP+1)th largest
  magnitude as the bar

The floor alone was not enough: a single year still drew ~80, because the paychecks, rent and
mortgages all sit in the same band. The cap fixes that, and **ties drop out together** — the bar
lands exactly on the paycheck amount, so all 26 disappear at once rather than being marked in
some months and not others. Result: 2-17 markers per view instead of 27-81. The legend prints
the live threshold, so it never lies about what is being shown.

**Default scenario is now: rent the Midland home 36 months, then sell** (Oct 2029). Ranked on
buying power at Dec 31 2030, in Aug 2026 dollars:

| | sale | buying power | net worth |
|---|---|---|---|
| sell now | Oct 2026 | $246,336 | $449,761 |
| 6 mo rent | Apr 2027 | **$251,490** | $455,628 |
| 12 mo rent | Oct 2027 | $232,194 | $433,664 |
| 24 mo rent | Oct 2028 | $244,763 | $447,971 |
| **36 mo rent** | Oct 2029 | **$256,178** | $460,964 |
| never sell | — | $147,861 | $464,316 |

The ranking is **not monotonic in term** — 12 months is the worst of all of them. Renting past
the relo deadline costs 7.5% of the price, and only a long enough tenancy earns that back.

### The relocation window (rule 8)

7/20/2026 + one year. The sale must **close** on or before `RELO_DEADLINE` — not merely be
under contract. Past it, `reloOK` is false and **every** relo benefit is gone at once:

| Benefit | Inside the window | After it |
|---|---|---|
| Seller closing costs | relo pays | `price x 7.5%` out of pocket at close |
| Loss-on-sale credit | up to $25,000 | $0 |
| Interest reimbursement | 2 payments max, while double-mortgaged | stops |

The reimbursement is gated on the **payment date**, not the sale date — it is paid as
incurred. In practice both payments land Oct/Nov 2026 and the deadline never binds on them.

**One day matters enormously.** At $425k, closing 7/21/2027 instead of 7/20/2027 costs
**$31,875**; at $380k it costs $28,500 *plus* the $22,500 loss credit — **$51,000** for a
single day.

### Renting the Midland home (rule 7)

`rentSchedule(rent)` puts income on the **1st of each month** — the first 1st on or after the
start date, then one a month for the term — weekend-bumped like every other draft. `end` is
the day the tenancy is up.

While a tenant is in (`rented(d)`), **Cirro, Atmos, Midland water and the Vivint draft stop**.
The **PennyMac mortgage keeps drafting** — you still owe it — and the rent lands as income
against it. The Vivint *contract buyout* still fires 7 days before the sale; only the monthly
$8.58 pauses.

**A sale cannot close before the tenancy ends.** `saleMin` is the rent end date, applied to
`#saledate.min`. A date parked exactly on that floor **rides it**: it follows the floor as the
term changes, and when renting is switched off it is restored to whatever it was before renting
first pushed it (`SALE_BEFORE_RENT`). A date the reader typed is never moved — that distinction
is the whole point, and without the restore, toggling renting off left the sale stranded in
2027 and silently cost $50k in the projection. If the tenancy runs past `T1` the sale input is
disabled and the scenario becomes "never sold".

### The two rules collide, and the app says so

Renting past 7/20/2027 forfeits the relo benefits. From a **Nov 1 2026** start, **8 months is
the longest term** that still frees the house inside the window (ends 7/1/2027; 9 months ends
8/1/2027 and is too late). `#rentwarn` turns red and names the cost the moment the term
crosses it; `#relowarn` does the same on the sale date itself.

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

**Auto-pay moved from the 16th to the 1st on 2026-09-11.** The Sept 16 draft became Oct 1 and
there is **no September 2026 payment**; past drafts are untouched, since Aug 17 is emitted
separately from `CAR_DATES`. Because interest accrues per diem, that one 46-day gap (vs 31)
sends $347.10 of the payment to interest instead of $233.91:

| | on the 16th | on the 1st |
|---|---|---|
| maturity | 2031-07-16 | **2031-08-01** |
| interest from here | $7,171.92 | **$7,333.08** |
| final payment | $198.47 | $359.63 |

So the shift costs **$161.16** over the life — the payment is unchanged and the extra lands
entirely in the final instalment. Near term it *helps*: skipping September frees a full $824.76
in the tightest month of the plan.

**Payments run until something stops them**, and only two things do: a sale (payoff two months
later, remaining balance settled in full) or the loan amortising to zero. With no sale the
drafts continue unbroken to **2030-12-16 — 53 payments, $43,712.28 paid, $5,057.52 still owed**
at the end of the window. Left alone the loan clears **2031-07-16** on a final short payment of
$198.47, past `T1`, which is why the tile reports what is still owed rather than a payoff.

The `t_car` tile therefore has three states: settled by a sale inside the window; a payoff that
lands past `T1` (sales after ~Oct 2030); or no sale at all. The **warranty refund is emitted
inside `if(carPayoff>0)`** — it is triggered by the payoff, so it must never fire without one.

### Payroll math (how PAY10 / PAY5 were derived)

From two paystubs differing only in overtime:
- marginal take-home **62.35%** of gross (24% fed + 6.2% OASDI + 1.45% Medicare + 6% Roth)
- **$54.63 net per OT hour** (OT gross rate $87.615)
- **zero-OT check = $3,283.99**; each OT hour adds $54.63
- 26 checks/year ⇒ 10 two-check months and 2 three-check months

### Sale-dependent logic

| Thing | Rule |
|---|---|
| PennyMac payments | drafted only while unsold; exact amortization at 5.375% from $336,756.31. **`mortgageSchedule()` must run to `T1`** — `payoffOn()` walks the same rows, so a short schedule does not merely drop drafts, it stops amortising and then piles per-diem interest on a stale balance. Truncated at 2027-12 it lost 36 drafts ($83,474) and overstated a Dec 2030 payoff by **$78,901** |
| Loan payoff | remaining principal + per-diem interest since the last payment |
| Proceeds | `price − payoff`, landing **on** the sale date (relo covers commissions/seller costs) |
| Relo interest reimbursement | day after each payment, **max 2**, and only while **all** of: you are carrying two mortgages (not while renting a place yourself), the Midland house is **vacant** (a tenant disqualifies it — confirmed with relo), and the payment falls inside the relo window. The tenant test is **per payment, not retroactive**: months already reimbursed while the house sat empty are kept, so renting from Dec 2026 still collects the Oct and Nov payments |
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
⚠️ **NY Life is the one recurring bill that is not inflated** — it is a level-premium life
policy, fixed for the life of the contract, so `inflAt()` must not be applied to it. Every
other subscription in that block carries `*inflAt(d)`; this one deliberately does not.
Spotify $20.56; car insurance $940 on 9/25 and each 6 months after (3/25/27, 9/27/27);
new-home utilities $150 / $250 / $300 Oct–Dec 2026, then a seasonal 2027 table
($195 in May up to $330 in Jan and Aug) — **estimates, not statements**.
2027 paychecks are generated biweekly from 12/25/26: 26 checks, three-check months
**April and October**.

**Food and miscellaneous are $0** — the spouse covers them.

---

## 4b. Page order

Deliberate, top to bottom:

```
h1 + one-line subtitle
card ─ tiles (8, one horizontally scrolling row)
     ─ action bar: [All|2026|2027]            [scenario btn] [Reconcile]
     ─ timeline + legend
     ─ <details> Transactions (paginated, `.secsum` header)
     ─ <details> Assumptions & sources
card ─ <details> Where the closing money goes   <- bottom, collapsed
modals ─ #setmodal, #recmodal (siblings of the cards, position:fixed)
```

Prose is kept to a minimum: the subtitle is one line, the two long descriptive
paragraphs are gone, and the assumptions live in a closed `<details>`. **The numbers do
the explaining** — the scenario button is labelled with the live scenario
(`Oct 30, 2026 · $425,000`, or `Never sold`), which is why removing the descriptive
paragraph lost nothing.

### The tile strip

The 8 tiles are **one non-wrapping row** (`.tiles`, flex, `flex:0 0 205px` each) that scrolls
horizontally with the scrollbar suppressed on every engine
(`scrollbar-width:none` + `-ms-overflow-style` + `::-webkit-scrollbar{display:none}`).
`overscroll-behavior-x:contain` stops a swipe past the end from scrolling the page.

With no scrollbar the only affordance is the **edge fade**: `.tilewrap::before/::after` are
gradients to `--surface-1`, revealed by `more-l` / `more-r`, which `tileFades()` toggles on
scroll, on resize and at the end of `render()`. Both fades show mid-strip; neither shows when
everything fits. If you ever change the card background, change the gradient stop with it or
the fade will show as a grey smear.

**Tile order is deliberate: the three that matter are the three you see without scrolling** —
Today, Net worth, Ending balance — then the cash-crunch pair, then sale outcomes, then the
long tail. Reordering the markup is all it takes; nothing in `render()` depends on position.

Tiles are **231px** on desktop and **`calc((100% - 14px)/3)` on mobile**, which puts exactly
three on screen. ⚠️ `.tile` needs **`box-sizing:border-box`** for that to hold: `flex-basis`
sizes the *content* box, so padding and border were adding 18px per tile and only 2.76 fitted.
The desktop basis went 205 → 231 at the same time to keep its rendered width unchanged.

Labels are short on purpose (`Today`, `Net worth`, `Payoff at sale`) so they hold one line at
129px of content width; the detail lives in the `.sm` line underneath.

**Touch swipes the strip natively, a mouse cannot** — with the scrollbar hidden there is
nothing to grab, and a vertical wheel scrolls the page. Desktop therefore gets two additions,
both behind `@media (hover:hover) and (pointer:fine)` so they never appear on a phone:

- **Edge arrows** (`.tnav`, `#tprev`/`#tnext`) that ride on the fades and share their
  `more-l`/`more-r` visibility, so an arrow only shows when there is something that way.
  A click jumps 80% of the visible width.
- **Drag-to-pan**, mouse pointers only (`e.pointerType!=='mouse'` bails, leaving touch to the
  browser). It engages only past a **5px threshold**, so a plain click can still select a
  figure to copy; `user-select:none` is applied on engage, not on press.

Plain vertical wheel is deliberately **not** hijacked — it would steal page scrolling whenever
the cursor crossed the strip. Shift+wheel already pans it natively.

`tileFades()` also toggles `can-scroll`, which is what gates the `grab` cursor.

The tiles deliberately overhang the viewport inside that clip, so a naive "is anything past
`clientWidth`" check will flag them. The real test is `documentElement.scrollWidth >
clientWidth`, which stays false at every width.

### The two sheet buttons

Both are **icon-only** (`.iconbtn`, 36x32, inline SVG on `currentColor` so it inverts on the
accent fill) and carry the wording in `title` + `aria-label` instead of on screen: sliders for
the scenario sheet, a circled check for reconcile. `#setbtn`'s label is **live** — it reads
`Sale settings — Oct 30, 2026 · $425,000`. Because that text is no longer visible, the same
string is also written into the **net-proceeds tile's** `.sm` line, so the scenario is still
readable without hovering. Drop that and the sale price disappears from the page entirely.

**`#setbtn`** holds the sale date, price and the "never sold" switch; edits apply live through the normal `render()` path, so *Done* only
closes the sheet — there is no apply step and no separate state to reconcile.
**`#recbtn`** is unchanged in behaviour: still `hidden` until `refreshTrigger()` finds an
eligible date, just no longer disguised as a low-contrast dot. It is set visible from an
**async** continuation (`loadState`), so a synchronous check right after parse will always
see it hidden — that is timing, not a bug.

`VIEW` defaults to **`'2026'`**; the matching `.vbtn` must carry `class="vbtn on"` and
`aria-pressed="true"` in the markup to match.

---

## 5. Closing figures (the donut — collapsed, at the foot of the page)

**Every figure here is derived from `DOWN_PCT`, an input defaulting to 22%.** Raising the
percentage raises the cash *and* shrinks the loan, so four things move together:

```
down    = 529,900 x pct          loan    = 529,900 - down
P&I     = loan amortised at 5.99% / 360   prepaid = loan x 5.99% / 365 x 13
```

The regression guard is that **`DOWN_PCT = 20` reproduces the original Closing Disclosure to
the cent** — $105,980.00 down, $423,920.00 loan, $2,538.89 P&I, $904.40 prepaid. Cash to close
is $100,847.90 rather than $104,462.90 only because the fence has since been paid separately.

Figures updated from the revised Closing Disclosure on 2026-09-10: **discount points
$11,742.48** (was a round $12,000), **3-month insurance escrow $425.49**, and a **county tax
adjustment of −$96.16** crediting the seller's share of the lot tax Jan 1 → Sept 18 (roughly
$135/yr × 261/365). Then on 2026-09-11: the lender's **minimum property-tax escrow is $50/mo**, so closing collects
4 x $50 = **$200** (not 12 months of the $135 lot assessment) and the ongoing collection is
$50/mo rather than $11.25. Separately, the **12-month insurance premium ($1,702) is paid by
your fiancée** and never reaches your closing table — but the lender still escrows for the
*renewal*, so the 3-month cushion stays and insurance stays in the monthly escrow.

`NH_ESC_START` is `425.49 + 200.00 = $625.49`; it and the escrow slices must always move
together. Note `NH_LOT_TAX` ($135) is what is actually **billed**, while `NH_TAX_ESC_MO` ($50)
is what is **collected** — collecting more than the bill banks a surplus through 2026-27, which
softens the Dec 2027 deficiency from −$4,150.62 to −$3,629.26.

**Items paid outside closing stay in gross costs and appear as a credit** — the earnest money
(Aug 12) and now the **fence, wired Sept 10 2026** ($3,615 plus a $30 wire fee). They are real
costs of the deal, so removing them from gross would misstate what the house cost; crediting
them is what stops the cash figure double-counting. The matching cash events live in
`buildEvents` at `FENCE_PAID`.

The check that this is right: moving the fence forward changed the Sept 18 shortfall by
**exactly $30** — the wire fee, and nothing else. Same money, eight days earlier.

`drawDonut()` is a function, not an IIFE, and **clears the SVG and the legend before redrawing**
— it runs on every render. Points, fence, insurance and the escrows do not scale with the loan — `$11,742.48` is the
quoted figure at 22% down, so changing `DOWN_PCT` afterwards will not re-price it.
`netWorth` amortises `nhLoan()`/`nhPI()`, not the old hardcoded $423,920.

⚠️ **At 22% the Sept 18 shortfall goes from $438 to $11,013.16** and the Oct 1 low from
−$3,114.63 to −$13,690.02. The bridge is no longer a rounding error.



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
- **Window control** is a select plus steppers (`#viewsel`, `#vwprev`/`#vwnext`), built from
  `T0`..`T1` at load, so a longer horizon needs no markup change. Six buttons did not survive
  going to five years; this also matches the transactions pager, so both read the same way.
  `VIEW` slices the series for the chart only. Tiles stay whole-series — "Lowest point" is a bridge-sizing number and must not
  change when you page to 2027. `ti`/`si` are indices into the *windowed* array, so the
  today-balance tile computes its own index (`tdi`) into the full array.
- **The chart scrolls sideways on a phone.** 53 months in 340px is unreadable, so mobile gives
  it a floor of **30px per month** (`W = max(cw, nMonths*30)`) inside `.tlwrap`, an
  overflow-x container with the same hidden-scrollbar and edge-fade idiom as the tile strip.
  ⚠️ **The fades belong on `.tlouter`, which does not scroll — never on `.tlwrap` itself.** An
  absolutely-positioned pseudo-element inside a scroll container is part of the *scrollable
  content*, so it travels with the chart and reads as a dark band welded to the graph. The tile
  strip had this right (`.tilewrap` hosts, `.tiles` scrolls); the chart did not.
  **Desktop keeps `width:100%`** and scales the fixed 940 viewBox — pinning real pixels there
  stopped it filling wide screens.
- ⚠️ **`touch-action` on `#tl` is set per window in `render()`, and the two values are not
  interchangeable.** Not pannable → **`pan-y`**: horizontal drags reach us so the scrub works,
  vertical ones still scroll the page. This is why single-year views were never affected.
  Pannable → **`none`**: the chart sits in a live scroll container *and* the edge auto-pan
  writes `scrollLeft` mid-gesture. Leave the browser any scroll behaviour to fall back on and
  it claims the sequence and fires **`pointercancel`**, which ends the scrub mid-drag — the
  reported "dragging suddenly stops". Taking the gesture outright is the only reliable fix; the
  cost is that you cannot scroll the page by dragging on the chart in that one window.
  A raw **`touchmove` fallback** re-arms tracking if a cancel slips through anyway.
  Note this class of bug is **invisible to synthetic tests**: dispatching `PointerEvent`
  bypasses the gesture recogniser entirely, so a scripted drag passes while a real finger fails.
- ⚠️ **`touch-action` on `#tl` must never be `pan-x`.** Scrubbing the balance readout
  and panning the chart are *both* horizontal drags on the same pixels, so they cannot be
  disambiguated by direction. Declaring `pan-x` hands the gesture to the browser and the readout
  silently stops working on touch. Panning therefore gets its own control: **`.tlbar`**, a real
  scrollbar under the chart with `touch-action:none`, dragged at `scrollWidth/clientWidth` so one
  sweep covers the whole span. It appears only when there is travel, which makes it the
  affordance as well as the control.
- **Ending balance, buying power and net worth all follow the window.** `endDay` is defined
  once beside `VD` and all three measure as of it. `netWorth(res, sale, rent, home, asOf)` takes
  the date rather than assuming `T1`, which fixed more than scoping: viewing 2027 with a 2029
  sale now **counts Midland equity as an asset**, because the house genuinely is not sold yet.
  Depreciation for the deferred-tax charge counts only months rented *through* `asOf` too.
- **Only `VIEW==='all'` may overflow** (`canPan`). A single year is pinned to the container, so
  it never scrolls and the gesture is never ambiguous even in principle.
- **Edge auto-pan during a scrub.** On the multi-year window only ~29% of the chart is on
  screen, so a drag runs out of *screen* long before it runs out of *timeline*. Holding within
  46px of either edge pans the chart at 13px per frame and re-runs `showAt` from the stored
  `liveTouch`, so one continuous drag walks the whole span with the readout live. The hit rect
  takes a **pointer capture**, so the scrub survives the finger leaving the SVG as it moves
  underneath. `stopEdge()` fires on lift, cancel and `hide()` — a stray interval would keep
  scrolling after the finger is gone.
- Because the SVG can now be wider than its container, **axis thinning is computed from actual
  pixels per month** (`ceil(55 / (iw/nMon))`), not a month-count guess, which read it wrong.
  January is always labelled and carries the year (`Jan '27`), and the spacing counter
  **resyncs from January** so you never get Dec/Jan/Feb in a row.
- The readout is positioned against **`.card`**, not `svg.parentNode` — the SVG's parent is now
  the scrolling wrapper, and measuring from it would misplace the tooltip once scrolled.
- **The scenario sheet is two columns above 760px** and widens to 840px. `.ctl-wide` and the
  nested `#rentfields`/`#hfields`/`#hbuyfields` grids span both columns. ~20 fields in one
  column is fine on a phone and absurd on a desktop.
- **Transactions** is styled as a real section rather than a bare triangle: `.secsum` is a
  bordered, full-width header row (icon, title, live count from `#tblmeta`, chevron) whose
  bottom corners square off when open to meet `.secbody`. Assumptions stays a plain small
  disclosure — that hierarchy is deliberate, one is a feature and one is fine print.
- **Table** shows a true per-transaction running balance (`run`), resynced to the day's close
  after each day so a reconcile rebase carries. Rows are **built forward** — the running
  balance depends on it — and only **reversed at render** (`[...page].reverse()`), so the
  table reads newest-first like a bank statement while each row still shows the balance
  *after* that transaction. Money in is green (`td.pos`); outflows stay default, since
  colouring them red would light up almost every row and signal nothing. Every row is built over the whole series, then
  **only the selected month is written to the DOM** — pages follow the window control, so
  picking "2027" scopes the pager to 12 pages. `PMONTHS` / `TPAGE` hold the paging state.
  The pager cannot use the `$` helper: it is declared `const` further down and is still in the
  TDZ when `render()` first runs.
- **The table opens on the current month** and keeps re-snapping to it until the reader pages
  somewhere themselves (`TPAGE_PINNED`). The re-snap matters: `TODAY_ISO` is the *client* date
  at first render and is replaced by the **server's** date when `/api/state` resolves, so
  without it a wrong device clock would strand the table on the wrong month — the same
  correction the TODAY marker already gets. When the current month falls outside the window
  (2027 selected in August 2026) it takes the nearest month **forward**, not `PMONTHS[0]`.
- **Scenario controls** live in `#setmodal`; `.controls` is a plain vertical stack there. The sale price is a **text**
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

## 8. Current headline numbers (Oct 30 sale, price derived, no reconciles)

**Two guards moved on 2026-09-02 and the move is correct, not a bug.** Adding Midland property
tax (rule 13) and deriving the price from the date (rule 16) both change the default scenario:

| Guard | Before | Now | Why |
|---|---|---|---|
| Sept 17, 2026 | $100,194.85 | **unchanged** | nothing new lands before the closing |
| Oct 1, 2026 low | −$3,114.63 | **unchanged** | ditto |
| Dec 31, 2026 | $34,641.71 | **$30,010.83** | −$3,751.17 tax prorated at closing, −$1,511.99 net price effect, +$632.28 escrow refund |
| Dec 31, 2027 | $96,709.57 | **$97,622.04** | ⬆ the old model stepped OKC up in Jan 2027, eleven months too early |
| Dec 31, 2030 | $289,886.76 | **$285,774.20** | modelling both escrows properly is nearly a wash over the window (−$143) — the old figure had the right total and the wrong timing |
| Vivint buyout | $1,289.79 | unchanged | |
| Car payoff | $38,563.57 | unchanged | |

Net worth on that scenario is **$445,146.58**. The account
runs under $15,000 for **42 days**, all of them under $5,000.

Never-sold, for contrast: cash **$71,576.02**, net worth **$363,734.74** — 52 PennyMac drafts
totalling **$145,078.73** is what holding the house actually costs, with $5,942.06 sitting in
escrow at the end.



- Sept 18 morning balance: **$101,204.89** vs a **$109,432.60** wire at 22% down →
  **$8,227.71 short**
- Lowest point: **−$11,729.33 on Oct 1** at 22% down
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
| Change the relo deadline or seller-cost % | `RELO_DEADLINE` / `SELLER_COST_PCT` |
| Change rent defaults | `RENT_DEFAULT` / `MYRENT_DEFAULT` / `BUY_DEFAULT` **and** the matching `value` attributes in the markup |
| Change the purchase lead time | `BUY_LEAD_MONTHS` |
| Change raises or inflation | `RAISE_PCT` / `INFL_PCT` (both keyed off 2027 as the base year) |
| Extend past 2030 | `T1`, `RANGE_END`, the `seasonal(...)` end years, `monthly(...)` ranges, `YEARS_AHEAD`, `mortgageSchedule`, a `.vbtn`, and the date `max` attributes |
| Resume extra car payments | `carWalk` — add to `CAR_PMT` for the relevant dates |
| Change the reconcile unlock hour | `RECONCILE_UNLOCK_HOUR` env var (client syncs from `/api/state`) |
| Change closing costs | the `slices` / `credits` arrays near the top of the script |
| Add a stat tile | markup in `.tiles` + a `set('t_xxx', …)` call at the end of `render()` |
| Change what the collapsed closing card shows | the `#accsum` block at the end of the donut IIFE |
| Open the closing card by default | add `open` to `<details id="closingcard">` |
| Change the default timeline window | `VIEW` initialiser **and** the `on`/`aria-pressed` markup on `.vbtn` |
| Change tile size | `.tile` `flex-basis` (desktop) and the `@media (max-width:640px)` override — keep mobile ≥ 180px or labels wrap |
| Reorder the page | the blocks inside `.card.pos`; modals can sit anywhere, they are `position:fixed` |
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
- Rent is modelled **gross**: no property-management fee (typically 8-10%), no vacancy
  allowance, no landlord-policy premium increase, no maintenance reserve, and no security
  deposit in or out. Enter a net figure if you want those covered
- Renting is assumed not to change the relo deadline itself, only whether you can meet it
- A 3% gross raise is applied as a 3% *net* raise; bracket drift is ignored
- Capital gains beyond depreciation recapture are not modelled, nor is the Sec.121 clock that
  renting eventually breaks (you must have lived there 2 of the last 5 years)
- 2028-2030 have no statement backing at all — they are the 2027 shapes grown at 3%
- The **escrow analysis is assumed annual, effective with the June draft.** PennyMac will know
  the 2026 assessment by autumn 2026 and could run an off-cycle analysis sooner, which would
  start the increase earlier and make the shortage smaller
- **PMI removal is assumed effective Nov 1, 2026.** It needs a written request and PennyMac may
  want a BPO or appraisal (~$500). If the house becomes a rental the threshold can rise to 30%
  equity, which would block it
- **`MID_TAX_NONHS` = $5,874.36 is a 1.30x guess** and the single most valuable number left to
  confirm with Midland CAD — at 0% appreciation the ranking flips at 1.31x
- No landlord costs: management fee, vacancy, maintenance, landlord-policy premium. Enter a net
  rent figure (~$2,321.67 for a $3,000 gross at 8% / 1 month vacancy / $2,500 maintenance)
- The **landlord insurance premium** is still the owner-occupied $1,329/yr. A DP-3 landlord
  policy typically runs 15-25% more, and because insurance is escrowed that would also feed
  the June escrow analysis — not a one-line change
- The suspension assumes MAGI stays above $150k. Below it the $25k special allowance would let
  you deduct rental losses **currently** instead of at sale — better, and worth checking against
  a real return
- Net worth assumes OKC appreciates 3%/yr and sells at 7% cost; neither is modelled as an input
- The **y-axis scrolls away** with the chart in the panned mobile view, since the whole SVG
  moves. Pinning it would mean splitting the axis into a second overlaid SVG
- Your own rent is modelled without a security deposit, application fees, renter's insurance,
  or a lease-break penalty if a purchase lets you leave early
- A later purchase reuses the current deal's figures as defaults ($104,463 cash, $3,181/mo).
  A 2027 purchase would have its own price and rate — they are inputs for that reason
- In rent-then-buy, the relo interest reimbursement is never paid, per your instruction, even
  though buying in 2027 while still owning Midland would briefly double up the mortgages
- The $2,300 warranty/gap refund is assumed to arrive as cash one month after payoff — some
  lenders instead apply it straight to the loan, which would reduce the payoff rather than
  pay you back
