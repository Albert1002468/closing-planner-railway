# Cash Flow Planner

Daily cash-flow and net-worth planner for the OKC home and the let (and possibly sold) Midland
home, with daily reconciliation against the real balance. See `PROJECT.md` for how it works.

Zero npm dependencies — pure Node (`node:http` + `node:sqlite`). Nothing to compile.

---

## Deploy to Railway

1. Push this folder to a GitHub repo (or use `railway up` from the CLI).
2. Railway → **New Project → Deploy from GitHub repo** → pick the repo.
3. **Add a volume** (this is what makes reconciliations survive redeploys):
   service → **Variables/Settings → Volumes → New Volume**, mount path **`/data`**.
4. Add environment variables (service → **Variables**):

   | Variable | Value | Notes |
   |---|---|---|
   | `RECONCILE_PASSCODE` | *(your choice)* | **Required.** The PIN for setting up a device's passkey. Without it no one can sign in. |
   | `RP_ID` | *(optional)* | Passkey domain. Defaults to the site's host; set it only if the domain is fronted by something unusual. ⚠️ Passkeys belong to a domain: changing domains means setting them up again. |
   | `DATA_DIR` | `/data` | Must match the volume mount path. |
   | `RECONCILE_UNLOCK_HOUR` | `19` | Optional. Hour (0–23, America/Chicago) that *today* unlocks. |
   | `ALERT_EMAIL`, `ALERT_EMAIL_PASSWORD` | | Optional bank sync from alert emails — see **Bank sync** below. |

5. **Settings → Networking → Generate Domain** for a public URL.

Railway sets `PORT` automatically — don't set it yourself.

### Verify after deploy

- Visit `/api/health` (public) — you should see `"storage": "sqlite"` and `"setupEnabled": true`.
- If `setupEnabled` is `false`, `RECONCILE_PASSCODE` isn't set and no device can be set up.
- If `storage` is `"json"`, the Node version is < 22 — still works, just uses a JSON file.
- ⚠️ If a Railway health check path is configured, use `/api/health`: everything else returns
  the sign-in page or 401 without a session.

## Signing in (passkeys / Face ID)

The **whole site** is behind sign-in: without a session every page shows the sign-in screen
and every API returns 401.

- **First time / a new device**: tap **Set up this device**, enter the PIN, and approve the
  passkey (Face ID on an iPhone). That signs you in. On Apple devices the passkey syncs through
  iCloud Keychain, so your other devices can usually just **Sign in with Face ID**.
- **Every device stays signed in for 30 days** after a sign-in (phone app, Safari, a computer),
  then asks for the passkey again. The device's own lock (Face ID, Touch ID, your computer's
  login) guards it in between. **Sign out of this device** is at the bottom of the Adjust &
  reconcile sheet.
- The PIN is never used to sign in directly — only to create a passkey. Eight wrong PINs
  from one IP lock setup for 15 minutes.
- Server side: passkeys (public keys only) and sessions (hashed tokens) live in the same
  database as the reconciles. Removing every passkey and setting up again needs a Railway shell
  (`DELETE FROM passkeys`).

## Bank sync (free: your bank's alert emails)

Optional and automatic. The banks email their own alerts (a daily balance, and one per
transaction) to a Gmail inbox used **only** for them; the server reads that inbox every 15
minutes. Nothing can move money, and nothing sits between you and the bank except Gmail.

1. Create a new Gmail account just for alerts (e.g. `yourname.bankalerts@gmail.com`). Turn on
   2-Step Verification, then create an **app password** (Google Account → Security → App
   passwords).
2. Railway variables: `ALERT_EMAIL` = that address, `ALERT_EMAIL_PASSWORD` = the app password.
3. In Wells Fargo (and later Chase) online banking → Alerts: send alerts to that address. Turn
   on the **daily balance** alert for checking and **transaction alerts** (purchases, deposits,
   withdrawals, payments) with the lowest amount it allows.
4. In the app: Adjust & reconcile → **Bank**. It starts as a **preview** — it shows the
   balances and transactions it read and what it would do, without changing anything. When it
   looks right, tap **Looks right — turn it on**.

Safety: only emails *from* wellsfargo.com / chase.com whose signature Gmail verified (DKIM) are
read, so a forged "balance" email is ignored. It never deletes, moves or marks emails read.
Alerts it cannot understand are listed under **Alerts it could not read** — send one (account
numbers hidden) so the reader can learn its wording.

What it does, every 15 minutes and whenever the app is opened:

- **Reconciles** the day a balance alert closes, from the bank's own (available) balance. Marked
  "From the bank"; adjusting a transaction never moves it. If the bank later reports a different
  figure for that day, it follows the bank (the change is in the audit log); your note on it stays.
- Wells Fargo: turn on **Account balance (daily)** with **Deposit has posted** and **Withdrawal has
  posted** — they arrive together as one morning email that lists everything that posted, including
  automatic payments that have no alert of their own. Card purchase alerts make purchases show up the
  same day; the morning email doesn't count them twice — a restaurant's posted amount with the tip
  (up to 35% more, same card, day and name) updates the alert's line instead of adding another. **Early Pay Day** deposits ("You just got
  paid early!") count on the day the money is usable, under the payer's name ("Deposited by"); when
  it posts a few days later, the morning email's Deposits line for it is not counted again.
- **Matches each new transaction to the plan**: same line → nothing; on another day or a few %
  off → the line is moved/adjusted; not in the plan → added as its own line (`Bank: …`); unsure →
  **To review** (a red count on the check-mark button): pick the line once and that payee is
  automatic from then on. A **green dot** there means the bank added or matched lines since you last
  opened Adjust & reconcile on that device; opening it clears the dot. A transfer between two ticked accounts is ignored.
  On a day you reconciled yourself, a purchase that doesn't clearly match a planned line by name is
  simply added on that day — your balance for it doesn't change. A transaction that
  comes **early** (up to 6 days before its planned day) moves its line to the day it came.
- **Moves what hasn't shown up**: from 8 PM (Chicago), a planned line the bank hasn't shown
  moves to tomorrow (one already past moves to today). Lines that are waiting are folded away under
  **Waiting for the bank** (nothing to do; open it to say one went through, today or on its planned
  day — for payments the bank doesn't alert on — or pick the day it will come). After 5 days of waiting it stops and asks there: **not yet** (move it to today or tomorrow and keep
  watching), **coming later** (pick the day it will post, up to 60 days ahead; it is watched for from
  then), it went through without an alert (back to its day), or it won't happen (set to $0). Lines you adjusted yourself, and lines planned before
  sync was turned on, are never moved. Have the bank alert on **every** transaction (set the amount
  threshold to the minimum), or lines it never alerts on will end up waiting here.

---

## Reconciliation rules (enforced on the server, not just the browser)

- A balance **from the bank** can't be typed over — only its note. Its variance is whatever the
  days before it leave: to change it, fix the earlier day.

- The trigger is the check-mark icon in the app bar. It appears once any date is eligible or
  any entry exists (so a past entry can always be corrected).
- It opens the Adjust & reconcile sheet (a bottom sheet on phones). Being signed in is the
  authorisation — there is no separate PIN.
- **Today** can be reconciled only after **19:00 America/Chicago**.
- **Past dates** with no entry stay open indefinitely — no time-of-day restriction.
- **Future dates** can never be reconciled.
- Each date can be reconciled **once**. To change a saved day, open it (or tap it under
  "Recent changes") and tap its reconciled balance (`PUT /api/reconciles`). Every
  **later** reconciled balance moves by the same amount, so their variances stay as entered;
  the change and every entry it moves are written to the audit log (`reconcile_edits`) in one
  transaction. Entries cannot be deleted.
- A variance of **$0.00 is valid** — it records that actual matched projection.
- Saving requires a signed-in session.
- There is no confirmation dialog: the sheet shows the projected balance, the variance and the
  new balance live before you save.

### Adjust & reconcile (one view)

The sheet opens on what matters now:

- **Bank** (top): when it last checked, the latest balance from the bank, and **Needs you** — only
  what it couldn't decide (which planned line a payment is) and lines that never showed up at the
  bank. Otherwise it says nothing needs you.
- **Your days**, newest first — tomorrow, today and the week before (**Earlier days** / **Later
  days** for more and **Back to today** to return, **Go to day** for any day, or **search** by name or note — best match first
  (a name that starts with what you typed, then one containing it, then a match in a note only),
  and among equals the one nearest today). Each day shows its
  balance and where it came from (*From the bank*, *Reconciled by you*, or *Projected*), and its
  lines, each marked with what the bank said: **bank ✓** (it went through as planned, or was moved
  / re-amounted to match), **from the bank** (a purchase not in the plan), **waiting** (not at the
  bank yet).
- At the bottom: bank accounts & settings, and **History** — every balance, adjustment and bank
  decision by day, newest first, each marked *bank* or *you*; tap one to open it in its day.

On a desktop the sheet fills the window in two columns that scroll on their own: the bank, its
settings and History (open) on the left, your days on the right, and the editor lays out what you
type beside what it does. On a phone it is one column, as above.

Going to a day (Go to day, a History row, a search result, Back to today) brings its card into
view with one slow glow of its border. Tap anything to change it; the editor opens right under it:

- **A transaction**: enter what actually happened and, if it cleared on another day, step
  **Cleared on** to that day (`PUT /api/adjustments`). The projection uses it from then on and
  the line is marked *adjusted* or *moved*; **Use projection** removes it
  (`DELETE /api/adjustments`). Any day in the window works, including future ones.
  **Reconciled variances stay as entered**: the line comes off its old day and lands on its new
  one, and every reconciled balance moves by the net change up to its date (moving a +$3,300
  rent off a reconciled day lowers that day's balance by $3,300; its variance is unchanged).
  The preview says which reconciled balances will move; each move is in the audit log.
  This is only for changes **you** make. When the **bank** moves or re-amounts a line (a match, a
  line not there yet), no reconciled balance moves: they were real balances, so the variance changes.
- **Several at once**: open one of the day's lines and tap **Move several lines from this day**,
  tick the others (or **Select all**), step **Move to** to the day they cleared and tap **Move**. One save (`PUT
  /api/adjustments` with `items`): each keeps its amount and note, reconciled variances stay as
  entered, and moving a line back to its own day clears it.
- **A day's balance** (the top of its card): *Reconcile ›* when it is eligible (enter the
  variance, `POST /api/reconciles`), or tap a reconciled one to change its variance — or, for one
  from the bank, its note.

### What a reconcile does

You enter the **variance** (actual − projected) for that day. The modal shows the projected
balance and the resulting **new balance** live as you type. On save the app stores the
resulting actual balance and:

- **rebases** the projection: every day after that continues from the new balance,
  so all later balances shift by the variance;
- shows the entry in the **transaction table**, the **Today** panel (if it is today) and the
  **chart readout** — but only when the variance is non-zero. A $0.00 entry is saved and locks
  the date, yet appears only under "Recent changes" inside the sheet.

**Original plan vs what happened, on the chart**: once the balance has left the plan, a **plan**
chip appears in the chart key (Cash mode). Tap it to draw your original plan as an orange dashed
line beside the blue balance: no reconciles, none of the bank's added lines (`Bank: …`), and every
planned line at its planned amount. It keeps the days lines actually came: a line that came early or
late, or is still waiting, is only timing, so it never counts as unplanned.
The readout shows the plan's figure and splits the gap in two: **unplanned** (lines not in the plan,
and every line that came in higher or lower than planned — a bigger paycheck, a smaller bill — whether
the bank or you entered it) and
**unexplained** (the reconcile variances: what the bank's balance shows that no alert explained).
The choice is remembered on the device.

The stored value is the resulting balance, so it stays pinned to reality; the variance shown
later is re-derived against whatever sale scenario is active.

---

## Backing up / reading the data

- `GET /api/state` (signed in) returns all entries as JSON — easiest backup.
- On the volume: `planner.db` (SQLite) or `reconciles.json` (fallback).
- To wipe and start over, delete the file from the volume via a Railway shell.

## Running locally

```bash
DATA_DIR=./data RECONCILE_PASSCODE=yourcode PORT=3000 node server.js
# open http://localhost:3000
```

Set `RECONCILE_UNLOCK_HOUR=0` locally if you want to test today's entry before 7pm.

---

## Privacy note

Nothing is public except the sign-in page, its icons and `/api/health`. The planner, its
figures and every API need a passkey sign-in.
