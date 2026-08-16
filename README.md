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
- **Today** can be reconciled only after **19:00 America/Chicago**.
- **Past dates** with no entry stay open indefinitely — no time-of-day restriction.
- **Future dates** can never be reconciled.
- Each date can be reconciled **once**. Entries cannot be edited or deleted from the UI.
- A variance of **$0.00 is valid** — it records that actual matched projection.
- Saving requires the passcode. Eight failed attempts from one IP triggers a 15-minute lockout.

### What a reconcile does

You enter the **actual** account balance for that day. The app stores that number
(scenario-independent) and:

- computes the **variance** = actual − projected for that day, under the current sale scenario;
- **rebases** the projection: every day after that continues from the actual balance,
  so all later balances shift by the variance;
- shows the entry in the **transaction table** (always, including $0 variance) and in the
  **timeline tooltip** (only when the variance is non-zero), along with any note.

Because the variance is computed against the live scenario, moving the sale date/price
sliders re-derives the variance — the stored actual balance never changes.

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
