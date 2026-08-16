# Closing & Home-Sale Planner

Cash-flow planner for the Sept 18, 2026 closing and the Midland home sale, with
permanent daily reconciliation.

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
   | `RECONCILE_PASSCODE` | *(your choice)* | **Required to save.** Without it the app runs read-only. |
   | `DATA_DIR` | `/data` | Must match the volume mount path. |
   | `RECONCILE_UNLOCK_HOUR` | `19` | Optional. Hour (0–23, America/Chicago) that *today* unlocks. |

5. **Settings → Networking → Generate Domain** for a public URL.

Railway sets `PORT` automatically — don't set it yourself.

### Verify after deploy

- Visit `/api/state` — you should see `"saveEnabled": true` and `"storage": "sqlite"`.
- If `saveEnabled` is `false`, `RECONCILE_PASSCODE` isn't set.
- If `storage` is `"json"`, the Node version is < 22 — still works, just uses a JSON file.

---

## Reconciliation rules (enforced on the server, not just the browser)

- The trigger is a deliberately low-contrast button below the chart footnotes, right side.
  It only appears when at least one date is eligible.
- Clicking it opens a centered modal that starts on a **PIN screen**. The PIN is checked
  against the server (`POST /api/verify`) before the form is revealed — a wrong PIN never
  gets you to the form. The PIN is held in memory only, never stored in the browser.
- **Today** can be reconciled only after **19:00 America/Chicago**.
- **Past dates** with no entry stay open indefinitely — no time-of-day restriction.
- **Future dates** can never be reconciled.
- Each date can be reconciled **once**. Entries cannot be edited or deleted from the UI.
- A variance of **$0.00 is valid** — it records that actual matched projection.
- Saving requires the passcode. Eight failed attempts from one IP triggers a 15-minute lockout.

### What a reconcile does

You enter the **variance** (actual − projected) for that day. The modal shows the projected
balance and the resulting **new balance** live as you type. On save the app stores the
resulting actual balance and:

- **rebases** the projection: every day after that continues from the new balance,
  so all later balances shift by the variance;
- shows the entry in the **transaction table** and the **timeline tooltip** — but only when
  the variance is non-zero. A $0.00 entry is saved and locks the date, yet appears nowhere
  except the "Recorded" list inside the modal.

The stored value is the resulting balance, so it stays pinned to reality; the variance shown
later is re-derived against whatever sale scenario is active.

---

## Backing up / reading the data

- `GET /api/state` returns all entries as JSON — easiest backup.
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

The page itself is **public to anyone with the URL** — only *saving* a reconcile requires
the passcode. This page contains bank balances, mortgage figures, and pay detail. If you'd
rather gate the whole site behind a password, say so and it's a small change to `server.js`.
