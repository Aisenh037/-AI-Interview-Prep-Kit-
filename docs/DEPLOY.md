# Deployment runbook

Three free services: **MongoDB Atlas** for data, **Render** for the API,
**Vercel** for the web app. About twenty minutes end to end.

The order matters — each step produces a value the next one needs.

---

## 1. MongoDB Atlas

1. Create a free **M0** cluster at <https://cloud.mongodb.com>.
2. **Database Access** → add a user with *Read and write to any database*. Use a
   long generated password.
3. **Network Access** → add `0.0.0.0/0`.

   This is a real trade-off rather than laziness. Render's free tier has no
   static outbound IP, so there is no narrower range to allow. It is
   compensated by TLS, SCRAM authentication, a long generated password and a
   user scoped to one database. The paid fix is Render static outbound IPs or
   Atlas PrivateLink.
4. Copy the connection string. It looks like
   `mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`.

---

## 2. Render — the API

1. **New → Web Service**, connect this repository.
2. Render reads `render.yaml`, so the build and start commands are already set:
   - Build: `npm install && npm run build:api`
   - Start: `npm start`
   - Health check: `/healthz`
3. Set the environment variables it asks for:

   | Variable | Value |
   |---|---|
   | `MONGODB_URI` | the string from step 1 |
   | `GROQ_API_KEY` | from <https://console.groq.com/keys> |
   | `AUTH_JWT_SECRET` | leave it — Render generates one |
   | `APP_BASE_URL` | your Vercel URL (step 3). Set it after, then redeploy. |
   | `CORS_ALLOWED_ORIGINS` | the same Vercel URL |
   | `BRAVE_SEARCH_API_KEY` | optional |

4. Deploy, then confirm:

   ```bash
   curl https://YOUR-API.onrender.com/healthz
   # {"data":{"ok":true,"uptime":3}}
   ```

**`NODE_ENV=production` is set in `render.yaml` and matters for more than
logging.** It is what makes the SSRF guard refuse private and loopback
addresses, and it overrides `ALLOW_PRIVATE_NETWORK` even if that is set to
`true`. There is a unit test asserting exactly that.

---

## 3. Vercel — the web app

1. **Add New → Project**, import the repository.
2. Settings:
   - **Root Directory**: `packages/web`
   - Tick **Include files outside the root directory** — the workspace install
     needs the repo root.
   - Framework preset: Next.js (detected).
3. Environment variables:

   | Variable | Value |
   |---|---|
   | `API_ORIGIN` | `https://YOUR-API.onrender.com` |
   | `NEXT_PUBLIC_API_BASE_PATH` | `/api/backend` |

   `API_ORIGIN` is **server-side only** and must not be prefixed
   `NEXT_PUBLIC_`. The browser never talks to the API directly.

4. Deploy, then go back to Render and set `APP_BASE_URL` and
   `CORS_ALLOWED_ORIGINS` to the Vercel URL, and redeploy the API.

---

## Why the cookie works

The browser only ever talks to the Vercel origin. `next.config.ts` rewrites
`/api/backend/*` to the Render service, so the session cookie is first-party and
`SameSite=Lax` is enough.

The alternative — calling the API directly from the browser — needs
`SameSite=None`, which Safari's tracking prevention blocks outright. A reviewer
opening the app in Safari would simply be unable to sign in, with no error to
explain why. The rewrite costs one config block and removes that entire class of
failure.

Rewrites are handled at the edge, not by a serverless function, so Vercel's
function timeout never applies to them. It would not matter anyway: generation
is a background job and the longest proxied request is a poll.

---

## Things that will look like bugs

**The first request takes 30–60 seconds.** Render's free tier sleeps after
fifteen minutes idle. The app pings `/healthz` when the new-kit page opens and
shows "Waking the research service…" rather than a dead spinner. For a demo,
an UptimeRobot check every ten minutes keeps it warm.

**A kit that was generating when the instance slept.** The job holds a lease
that lapses while the process is down. On the next boot a sweeper requeues it
and it resumes. Without that, a killed process leaves a kit spinning forever —
the most likely "this app is broken" moment in a review.

**Atlas M0 connection limits.** The API uses `maxPoolSize: 5` and opens one pool
at boot, never per request.

**A misconfigured variable fails fast.** Environment is validated at startup, so
the service exits in milliseconds with a readable list rather than 500ing on the
first request that happens to need it.

---

## Verifying a deployment

```bash
curl https://YOUR-API.onrender.com/healthz          # API is up
curl -I https://YOUR-APP.vercel.app/login           # web is up
curl https://YOUR-APP.vercel.app/api/backend/auth/me # proxy reaches the API (401 is correct)
```

Then, in a browser: register, create a kit against a real company URL, watch the
step list fill in, edit a question, pin another, regenerate that category and
confirm both survive. **Do this once in Safari** — it is the browser where the
cookie path is most likely to break.

The batch entry point does not need any of this. It runs from a clean clone with
only `GROQ_API_KEY`.
