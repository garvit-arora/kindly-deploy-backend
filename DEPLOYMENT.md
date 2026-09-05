# KindlyDeploy — Production Deployment

## Topology

| Piece | Platform | Why |
| --- | --- | --- |
| Frontend (Vite/React SPA) | **Vercel** | static build, global CDN, free |
| API (`server.js`) | **Azure Web App** (Linux, Node 20) | must be publicly reachable for GitHub webhooks + OAuth callback |
| Worker + Docker + Traefik | **Azure VM** (Ubuntu) | App Service cannot build/run Docker containers |
| Postgres | **Prisma Postgres** | managed, no firewall rules to manage |
| Redis | **Upstash** | managed, TLS, reachable from both App Service and the VM |

The API and the worker are the same repository but **two separate processes on two separate machines**.
They never call each other directly — they communicate through Redis (BullMQ queue) and Postgres.
That is exactly why the control plane / data plane split makes this deployment possible.

Anything that shells out to `docker` must run on the VM only. The API is Docker-free.

---

## Step 1 — Prisma Postgres

```bash
cd backend
npx create-db
```

Copy the **direct** `postgresql://...` connection string (not the `prisma+postgres://` Accelerate URL —
this project uses the `@prisma/adapter-pg` driver adapter, which needs a real Postgres URL).

## Step 2 — Upstash Redis

Create a Redis database at upstash.com and copy the `rediss://...` connection URL.
TLS is enabled automatically by `src/lib/redisConnection.js` because the scheme is `rediss:`.

## Step 3 — Apply the schema

```bash
cd backend
DATABASE_URL="<prisma postgres url>" npx prisma migrate deploy
```

`migrate deploy` only applies existing migrations. Never run `migrate dev` against production.

## Step 4 — Azure VM (worker + Docker + Traefik)

Create an Ubuntu VM. Open inbound ports **22** and **80** in its Network Security Group.
Note its **public IP**.

```bash
# Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker
docker network create kindlydeploy-network

# Node + pm2
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pm2

# App
git clone https://github.com/garvit-arora/kindly-deploy-backend.git
cd kindly-deploy-backend
npm install
npx playwright install --with-deps chromium   # needed for preview screenshots
```

Create `backend/.env` on the VM from `.env.example`, with:

```
NODE_ENV=production
DATABASE_URL=<prisma postgres url>
REDIS_URL=<upstash rediss url>
DEPLOYMENT_BASE_HOST=<VM_PUBLIC_IP>.nip.io
DEPLOYMENT_HEALTH_CHECK_HOST=127.0.0.1
ENCRYPTION_KEY=<same value as the API>
GITHUB_APP_ID=...
GITHUB_PRIVATE_KEY_BASE64=...
IMAGEKIT_*=...
```

`ENCRYPTION_KEY` **must be identical** on the API and the worker — the API encrypts environment
variables, the worker decrypts them.

Start Traefik and the worker:

```bash
docker compose -f traefik.compose.yaml up -d
pm2 start npm --name kindlydeploy-worker -- run worker
pm2 save && pm2 startup
```

Deployed apps become reachable at `http://<deployment-id>.<VM_PUBLIC_IP>.nip.io`.

## Step 5 — Azure Web App (API)

Create a Linux Web App, Node 20, with **Always On** enabled (the SSE log stream holds long-lived
connections; without Always On the app is unloaded when idle).

Application settings:

```
NODE_ENV=production
DATABASE_URL=<prisma postgres url>
REDIS_URL=<upstash rediss url>
FRONTEND_URL=https://<your-app>.vercel.app
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GITHUB_CALLBACK_URL=https://<api>.azurewebsites.net/api/auth/github/callback
GITHUB_APP_ID=...
GITHUB_APP_SLUG=...
GITHUB_PRIVATE_KEY_BASE64=<base64 of the .pem>
GITHUB_WEBHOOK_SECRET=...
IMAGEKIT_PUBLIC_KEY=...
IMAGEKIT_PRIVATE_KEY=...
IMAGEKIT_URL_ENDPOINT=...
ENCRYPTION_KEY=<same value as the worker>
SCM_DO_BUILD_DURING_DEPLOYMENT=true
```

Generate the base64 private key:

```bash
base64 -w0 keys/github-app.pem      # Linux/Git Bash
```

Do **not** set `PORT` — Azure injects it. `npm start` and `postinstall: prisma generate` are already
in `package.json`, so Oryx builds correctly.

Deploy with **`az webapp deployment source config-zip`**, not `az webapp deploy`:

```bash
git archive --format=zip -o /tmp/api.zip HEAD
az webapp deployment source config-zip -n kindlydeploy -g kindlydeploy_group --src /tmp/api.zip
```

`az webapp deploy --type zip` uses the OneDeploy path, which extracts the archive but **never runs
`npm install`**, even with `SCM_DO_BUILD_DURING_DEPLOYMENT=true` and `ENABLE_ORYX_BUILD=true`. The
container then dies with `Cannot find module 'dotenv'`. `config-zip` goes through Kudu's push
deployer and does a real remote Oryx build, which is what installs dependencies and runs
`prisma generate`.

Using `git archive` also guarantees only committed files ship — `.env` and `keys/` are gitignored,
so they never leave your machine.

`FRONTEND_URL` accepts a comma-separated list if you also want Vercel preview domains allowed by CORS.
The first entry is the one used for OAuth redirects.

## Step 6 — Vercel (frontend)

- Import `https://github.com/garvit-arora/kindly-deploy-frontend`
- Root Directory: repository root (the frontend is its own repo)
- Environment variable: `VITE_API_URL=https://<api>.azurewebsites.net`
- `vercel.json` already sets the SPA rewrite so client-side routes don't 404 on refresh.

## Step 7 — GitHub App

Update in the GitHub App settings:

- Webhook URL → `https://<api>.azurewebsites.net/api/github/webhook`
- Callback URL → `https://<api>.azurewebsites.net/api/auth/github/callback`
- Setup URL → `https://<api>.azurewebsites.net/api/github/install/callback`

Redeliver the `ping` event and confirm a `200`.

---

## Why the code needed changing for this split

- **Cookies** — the frontend (Vercel) and API (Azure) are different sites, so the session cookie
  needs `SameSite=None; Secure` in production. `SameSite=None` without `Secure` is rejected by
  browsers, which is why it stays `lax` in local development.
- **`app.set('trust proxy', 1)`** — App Service terminates TLS at a front-end proxy. Without this,
  Express thinks the connection is plain HTTP and refuses to send `Secure` cookies.
- **GitHub private key** — App Service has no persistent place to put a `.pem`, so the key is passed
  as a base64 environment variable. The file path still works locally.
- **Stop-container endpoint** — previously ran `docker stop` inside the API. There is no Docker
  daemon on App Service, so the API now validates the request against the database and enqueues a
  cleanup job; the worker on the VM performs the actual stop.
- **Container logs endpoint** — previously ran `docker logs` inside the API. It now reads the
  `DeploymentLog` rows that the worker already streams into Postgres.
- **Deployment hostname** — was hardcoded to `127.0.0.1.nip.io`. It is now `DEPLOYMENT_BASE_HOST`
  so the VM can use its own public IP. The health check hits Traefik on localhost with an explicit
  `Host` header instead of looping out through the public IP.
