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
- **After that**: **Sign in with Face ID**. A session lasts **30 days** per browser (the
  home-screen app and Safari keep separate sessions). **Sign out of this device** is at the
  bottom of the Adjust & reconcile sheet.
- The PIN is never used to sign in directly — only to create a passkey. Eight wrong PINs
  from one IP lock setup for 15 minutes.
- Server side: passkeys (public keys only) and sessions (hashed tokens) live in the same
  database as the reconciles. Removing every passkey and setting up again needs a Railway shell
  (`DELETE FROM passkeys`).

---

## Reconciliation rules (enforced on the server, not just the browser)

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

The sheet shows one day at a time — step with **‹ ›** or tap the date for the
system picker — or **search** by name ("paycheck", "mortgage", a note) to list the matches
nearest today. Every row has a second line saying what it is (projected, adjusted, moved, the
projection it replaced, its note).

- **A transaction**: enter what actually happened and, if it cleared on another day, step
  **Cleared on** to that day (`PUT /api/adjustments`). The projection uses it from then on and
  the line is marked *adjusted* or *moved*; **Use projection** removes it
  (`DELETE /api/adjustments`). Any day in the window works, including future ones.
  **Reconciled variances stay as entered**: the line comes off its old day and lands on its new
  one, and every reconciled balance moves by the net change up to its date (moving a +$3,300
  rent off a reconciled day lowers that day's balance by $3,300; its variance is unchanged).
  The preview says which reconciled balances will move; each move is in the audit log.
- **Several at once**: tap **Select to move**, tick the lines (or **Select all**), step **Move
  to** to the day they cleared and tap **Move**. One save (`PUT /api/adjustments` with
  `items`): each keeps its amount and note, reconciled variances stay as entered, and moving a
  line back to its own day clears it.
- **The day's balance** (last row): *Reconcile this day* when it is eligible (enter the
  variance, `POST /api/reconciles`), or *Reconciled* to change the variance.
- **Recent changes** lists every reconcile and adjustment, newest first; tap one to open it.

### What a reconcile does

You enter the **variance** (actual − projected) for that day. The modal shows the projected
balance and the resulting **new balance** live as you type. On save the app stores the
resulting actual balance and:

- **rebases** the projection: every day after that continues from the new balance,
  so all later balances shift by the variance;
- shows the entry in the **transaction table**, the **Today** panel (if it is today) and the
  **chart readout** — but only when the variance is non-zero. A $0.00 entry is saved and locks
  the date, yet appears only under "Recent changes" inside the sheet.

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
