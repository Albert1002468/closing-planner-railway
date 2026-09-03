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
T0, T1      = '2026-08-14', '2030-12-31'   // 1,601 days, 53 table pages
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
RENT_DEFAULT = {start:'2026-10-01', months:6, amt:3300}
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
- **The ending-balance tile follows the window**, not the series: it reads `VD[VD.length-1]`,
  so selecting 2027 shows Dec 31 2027. Net worth deliberately does **not** follow — it is
  anchored to `T1` throughout (`payoffOn(T1)`, `priceOn(T1)`), so its `.sm` line says so.
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
| Dec 31, 2027 | $96,709.57 | **$92,078.69** | same, carried forward — the house is sold, so no further bills |
| Dec 31, 2030 | $289,886.76 | **$285,255.88** | same |
| Vivint buyout | $1,289.79 | unchanged | |
| Car payoff | $38,563.57 | unchanged | |

Net worth on that scenario is **$444,628.26** (cash $285,256 + OKC equity $159,372). The account
runs under $15,000 for **42 days**, all of them under $5,000.

Never-sold, for contrast: cash **$71,576.02**, net worth **$363,734.74** — 52 PennyMac drafts
totalling **$145,078.73** is what holding the house actually costs, with $5,942.06 sitting in
escrow at the end.



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
