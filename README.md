<div align="center">

<img src="https://img.shields.io/badge/KindlyDeploy-API-ef4d23?style=for-the-badge" alt="KindlyDeploy API" />

# KindlyDeploy — Backend

**A Vercel/Render-style Platform-as-a-Service, built from first principles.**

Webhook → queue → image build → container → routing → health check → live URL.

[![Node](https://img.shields.io/badge/Node.js-24-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white)](https://expressjs.com)
[![Prisma](https://img.shields.io/badge/Prisma-7-2D3748?logo=prisma&logoColor=white)](https://prisma.io)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)](https://postgresql.org)
[![Redis](https://img.shields.io/badge/Redis-BullMQ-DC382D?logo=redis&logoColor=white)](https://docs.bullmq.io)
[![Docker](https://img.shields.io/badge/Docker-Engine-2496ED?logo=docker&logoColor=white)](https://docker.com)
[![Traefik](https://img.shields.io/badge/Traefik-v3.6-24A1C1?logo=traefikproxy&logoColor=white)](https://traefik.io)

</div>

---

## Table of contents

- [What this is](#what-this-is)
- [Architecture](#architecture)
- [The deployment lifecycle](#the-deployment-lifecycle)
- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [API reference](#api-reference)
- [Data model](#data-model)
- [Environment variables](#environment-variables)
- [Running locally](#running-locally)
- [Production topology](#production-topology)
- [Design decisions](#design-decisions)
- [Troubleshooting](#troubleshooting)

---

## What this is

KindlyDeploy takes a GitHub repository with a `Dockerfile` and turns every push into a
running, routable, health-checked container — the same job Vercel or Render do, implemented
end to end rather than assembled from managed services.

This is an **explicit learning project**. Nothing is hidden behind a black box: the job queue,
the image build, the container lifecycle, the reverse proxy and the health check are all
visible and editable in this repository.

**What it actually does today:**

| | |
|---|---|
| 🔗 **GitHub App integration** | Reads repositories, branches and commits without ever running `git clone` |
| 📦 **Commit-exact builds** | Downloads the precise commit as a zipball via an installation token |
| 🐳 **Real Docker images** | Builds your `Dockerfile` and runs it as a container on a dynamic host port |
| 🌐 **Host-based routing** | Traefik routes `<deploymentId>.<base-host>` to the right container by label |
| ❤️ **Health gating** | A deployment only goes live once it answers HTTP on its own hostname |
| ↩️ **Rollback with grace** | The previous container stays alive for an hour, so rollback is instant |
| 📜 **Streamed logs** | Build output and runtime container logs are captured and persisted |
| 📸 **Preview screenshots** | Playwright captures the live app and uploads it to ImageKit |
| 🔐 **Encrypted env vars** | Per-project environment variables, AES-encrypted at rest |

---

## Architecture

The system is deliberately split into a **control plane** and a **data plane**. They never
call each other directly — they communicate only through Postgres and Redis. This is what
lets the worker live on a completely different machine from the API.

```
                          ┌─────────────────────────────┐
   git push ─────────────▶│  GitHub  (App + webhooks)   │
                          └──────────────┬──────────────┘
                                         │  webhook
                                         ▼
┌────────────────────────────────────────────────────────────────────────┐
│  CONTROL PLANE                                    (Azure App Service)  │
│                                                                        │
│   Express API  ──────────────▶  PostgreSQL   (users, projects,         │
│   • auth / sessions                            deployments, logs)      │
│   • projects & env vars                                                │
│   • enqueue build jobs  ─────▶  Redis / BullMQ   ── "deployments"      │
└────────────────────────────────────────────────────┬───────────────────┘
                                                     │  job
                                                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│  DATA PLANE                                             (Azure VM)     │
│                                                                        │
│   Deployment Worker                                                    │
│     1. download commit zipball      5. health check via Host header    │
│     2. docker build                 6. supersede previous deployment   │
│     3. docker run (dynamic port)    7. screenshot + log tailing        │
│     4. attach Traefik labels                                           │
│                          │                                             │
│                          ▼                                             │
│   Docker Engine ── kindlydeploy-network ── Traefik v3.6 ──▶ :80        │
│        └── container   └── container   └── container                   │
└────────────────────────────────────────────────────────────────────────┘
```

**Why the split matters:** builds are CPU- and disk-heavy. If they ran inside the API
process, a single large image build would stall every dashboard request. Separating them
means the worker can be scaled, moved or restarted without touching the API.

---

## The deployment lifecycle

A `Deployment` moves through a strict status machine:

```
PENDING ──▶ QUEUED ──▶ BUILDING ──┬──▶ READY
                                  └──▶ FAILED / CANCELLED
```

Every transition writes a `DeploymentActivity` row, giving each deployment a complete,
queryable audit trail. The worker records these phases:

| # | Phase | What happens |
|---|-------|--------------|
| 1 | `Deployment worker started downloading source code` | Installation token minted, zipball fetched for the exact commit SHA |
| 2 | `Source code downloaded and Dockerfile found` | Archive extracted, build context verified |
| 3 | `Building Docker image` | `docker build` streams output into `DeploymentLog` rows |
| 4 | `Starting Docker container` | `docker run` on a free host port, with Traefik routing labels attached |
| 5 | `Running HTTP health check` | Requests `http://<deploymentId>.<base-host>` through the proxy |
| 6 | `HTTP health check passed` | Status flips to `READY`; older deployments are marked `supersededAt` |
| 7 | `Deployment preview screenshot captured` | Playwright screenshot uploaded to ImageKit |

**Failure semantics** are deliberate and asymmetric:

- A failure **before** `READY` marks the deployment `FAILED` and force-removes its container.
- A failure **after** `READY` (screenshot, log tailing) leaves the deployment `READY` and only
  logs an activity row. Post-ready steps are best-effort and must never take down a live app.

**Zero-downtime cutover:** when a new deployment goes live, the previous container is *not*
stopped immediately. It is marked superseded and a delayed job on the `deployment-cleanups`
queue stops it an hour later. That hour is your rollback window.

**Rollback** does not restart an old container. It creates a **new** `Deployment` row copying
the old commit, branch and Dockerfile path, then re-runs the entire pipeline — so a rollback
is verified by the same health check as any other release.

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 24, CommonJS | Matches the Azure App Service runtime |
| HTTP | Express 5 | Small, explicit, no framework magic |
| Database | PostgreSQL + Prisma 7 | Typed queries and a real migration history |
| Queue | BullMQ 6 on Redis | Durable jobs, delayed jobs, retries |
| Containers | Docker Engine via `child_process.spawn` | The CLI is the teaching surface |
| Routing | Traefik v3.6 | Discovers containers from Docker labels automatically |
| Auth | Cookie sessions (SHA-hashed) | Simpler and safer than hand-rolled JWT |
| Screenshots | Playwright | Headless Chromium against the live deployment |
| Storage | ImageKit | Preview image hosting and CDN |

---

## Project structure

```
backend/
├── server.js                        # Entry point — loads dotenv, starts Express
├── traefik.compose.yaml             # Reverse proxy (runs on the deployment VM)
├── prisma/
│   ├── schema.prisma                # Single source of truth for the data model
│   └── migrations/
└── src/
    ├── app.js                       # Express app: CORS, auth, GitHub + health routes
    ├── lib/
    │   ├── prisma.js                # Shared Prisma client
    │   ├── redis.js                 # Shared ioredis client
    │   └── redisConnection.js       # Connection options for BullMQ
    ├── middlewares/
    │   └── requireAuth.js           # Session lookup by token hash
    ├── queues/
    │   ├── deploymentQueue.js       # "deployments" — build jobs
    │   └── deploymentCleanupQueue.js# "deployment-cleanups" — delayed teardown
    ├── routes/
    │   ├── projects.route.js        # Projects, deployments, rollback, env vars
    │   ├── deployments.route.js     # Deployment detail, logs, SSE log stream
    │   ├── overview.route.js        # Dashboard aggregate stats
    │   ├── account.route.js         # GitHub installations + session management
    │   └── domains.route.js         # Live deployment hostnames
    ├── services/
    │   └── deploymentCleanup.service.js
    ├── utils/
    │   ├── githubApp.js             # App JWT, installation tokens, repo/branch/commit reads
    │   ├── downloadRepository.js    # Commit zipball download + extract
    │   ├── docker.js                # build / run / inspect / logs / stop / remove
    │   ├── healthCheck.js           # HTTP polling with a custom Host header
    │   ├── deploymentLogWriter.js   # Tails `docker logs --follow` into Postgres
    │   ├── detectBuildStrategy.js   # Dockerfile vs Node frontend/backend detection
    │   ├── takeScreenshot.js        # Playwright capture
    │   ├── imagekit.js              # Upload helper
    │   ├── encryption.js            # AES helpers for environment variables
    │   └── session.js               # Token creation, hashing, expiry
    └── workers/
        └── deploymentWorker.js      # The data plane — must run as its own process
```

---

## API reference

All authenticated routes require the `kindlydeploy_session` cookie and respond `401`
with `{"message":"You are not signed in."}` when it is missing or expired.

### Health

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | API + database connectivity |
| `GET` | `/api/redis-health` | Redis connectivity |
| `POST` | `/api/queue-test` | 🔒 Enqueue a no-op job to verify the queue |

### Authentication

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/auth/github` | Begin GitHub OAuth (sets a CSRF `state` cookie) |
| `GET` | `/api/auth/github/callback` | Exchange the code, create a session, redirect to the dashboard |
| `GET` | `/api/auth/me` | 🔒 Current user |
| `POST` | `/api/auth/logout` | Destroy the current session |
| `POST` | `/api/auth/dev-login` | Local-only shortcut — **disabled when `NODE_ENV=production`** |

### GitHub App

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/github/install` | 🔒 Redirect to the App's installation page |
| `GET` | `/api/github/install/callback` | 🔒 Persist the installation, redirect to project creation |
| `GET` | `/api/github/repositories` | 🔒 Repositories across all installations |
| `GET` | `/api/github/branches` | 🔒 Branches for one repository |
| `GET` | `/api/github/detect` | 🔒 Detect the build strategy for a repository |
| `POST` | `/api/github/webhook` | Push events — signature-verified, enqueues a deployment |

### Projects

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/projects` | 🔒 All projects with their latest deployment |
| `POST` | `/api/projects` | 🔒 Create a project, verify the `Dockerfile`, enqueue the first build |
| `GET` | `/api/projects/:projectId/deployments` | 🔒 Deployment history |
| `POST` | `/api/projects/:projectId/deployments` | 🔒 Trigger a new deployment |
| `POST` | `/api/projects/:projectId/deployments/:sourceDeploymentId/rollback` | 🔒 Redeploy an earlier commit |
| `POST` | `/api/projects/:projectId/deployments/:deploymentId/stop` | 🔒 Stop a running container |

### Environment variables

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/projects/:projectId/environment-variables` | 🔒 List (values decrypted for the owner) |
| `POST` | `/api/projects/:projectId/environment-variables` | 🔒 Create or update |
| `DELETE` | `/api/projects/:projectId/environment-variables/:variableId` | 🔒 Remove |

### Deployments

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/deployments` | 🔒 All deployments for the user |
| `GET` | `/api/deployments/:deploymentId` | 🔒 Detail with activity trail |
| `GET` | `/api/deployments/:deploymentId/logs` | 🔒 All logs |
| `GET` | `/api/deployments/:deploymentId/build-logs` | 🔒 Build output only |
| `GET` | `/api/deployments/:deploymentId/runtime-logs` | 🔒 Container output only |
| `GET` | `/api/deployments/:deploymentId/logs/stream` | 🔒 Server-Sent Events live stream |

### Account & domains

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/account/github/installations` | 🔒 Installations + GitHub-side revoke URLs |
| `DELETE` | `/api/account/github/installations/:id` | 🔒 Disconnect an installation |
| `GET` | `/api/account/sessions` | 🔒 Active sessions, current one flagged |
| `POST` | `/api/account/sessions/revoke-others` | 🔒 Sign out every other device |
| `GET` | `/api/domains` | 🔒 Live deployment hostnames |

### Overview

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/overview` | 🔒 Aggregate dashboard statistics |

---

## Data model

```
User ──┬── Session            (tokenHash, expiresAt)
       ├── GithubInstallation (installationId, accountLogin, accountType)
       ├── Project ──┬── Deployment ──┬── DeploymentActivity
       │             │                └── DeploymentLog   (BUILD | RUNTIME)
       │             └── EnvironmentVariable  (encrypted)
       └── DeploymentActivity  (as actor)
```

**Enums:** `DeploymentStatus` (`PENDING`, `QUEUED`, `BUILDING`, `READY`, `FAILED`,
`CANCELLED`) · `BuildStrategy` (`DOCKERFILE`, `NODE_FRONTEND`, `NODE_BACKEND`) ·
`DeploymentLogSource` (`BUILD`, `RUNTIME`) · `DeploymentActivityType`.

---

## Environment variables

Create `backend/.env`. **This file is gitignored and must never be committed.**

### Core

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `REDIS_URL` | ✅ | Redis connection string (BullMQ) |
| `FRONTEND_URL` | ✅ | Allowed origin(s), comma-separated. **No trailing slash** |
| `PORT` | — | API port (default `4000`) |
| `NODE_ENV` | — | `production` enables `SameSite=None; Secure` cookies and disables dev login |
| `ENCRYPTION_KEY` | ✅ | Base64 key for encrypting environment variables |

### GitHub

| Variable | Required | Description |
|---|---|---|
| `GITHUB_CLIENT_ID` | ✅ | OAuth client ID — **login identity only** |
| `GITHUB_CLIENT_SECRET` | ✅ | OAuth client secret |
| `GITHUB_CALLBACK_URL` | ✅ | Must exactly match a GitHub App callback URL |
| `GITHUB_APP_ID` | ✅ | GitHub App ID — **repository access** |
| `GITHUB_APP_SLUG` | ✅ | App slug, used to build the install URL |
| `GITHUB_PRIVATE_KEY_PATH` | ◐ | Path to the App's `.pem` (local development) |
| `GITHUB_PRIVATE_KEY_BASE64` | ◐ | Base64 of the same key (hosted environments) |
| `GITHUB_WEBHOOK_SECRET` | ✅ | HMAC secret for webhook signature verification |

◐ Provide exactly one of the two private-key variables.

### Deployment host (worker)

| Variable | Required | Description |
|---|---|---|
| `DEPLOYMENT_BASE_HOST` | — | Wildcard host for deployments (default `127.0.0.1.nip.io`) |
| `DEPLOYMENT_HEALTH_CHECK_HOST` | — | Where the health check sends its request |

### ImageKit (screenshots)

| Variable | Required | Description |
|---|---|---|
| `IMAGEKIT_PUBLIC_KEY` | — | Public key |
| `IMAGEKIT_PRIVATE_KEY` | — | Private key |
| `IMAGEKIT_URL_ENDPOINT` | — | Delivery URL endpoint |

> **Two GitHub identities, on purpose.** OAuth answers *who is this user*. The GitHub App
> answers *what code may we read*. A user can be signed in without having installed the App,
> so any route needing repository access checks for an installation separately.

---

## Running locally

### Prerequisites

Node.js 24+, Docker Desktop, and a GitHub App you control.

### 1 — Start the infrastructure

```bash
docker compose -f docker-compose.yaml up -d      # PostgreSQL  (host port 5433)
docker compose -f redis.compose.yaml up -d       # Redis       (host port 6379)
docker network create kindlydeploy-network       # Required by runDockerContainer
docker compose -f traefik.compose.yaml up -d     # Traefik     (host port 80)
```

> `kindlydeploy-network` must exist before any deployment runs — containers are attached to
> it so Traefik can discover them.

### 2 — Install and migrate

```bash
npm install
npx prisma migrate dev
npx prisma generate
```

### 3 — Run both processes

The API and the worker are **separate processes**. Deployments will sit in `QUEUED` forever
if you only start the API.

```bash
npm run dev      # terminal 1 — API on :4000
npm run worker   # terminal 2 — deployment worker
```

### 4 — Verify

```bash
curl localhost:4000/api/health        # {"status":"ok", ...}
curl localhost:4000/api/redis-health  # {"status":"ok", ...}
```

### Scripts

| Command | Description |
|---|---|
| `npm run dev` | API with nodemon |
| `npm start` | API without nodemon (production) |
| `npm run worker` | Deployment + cleanup workers |
| `npx prisma migrate dev` | Create and apply a migration |
| `npx prisma studio` | Browse the database |

---

## Production topology

| Component | Host |
|---|---|
| Frontend | Vercel |
| API (control plane) | Azure App Service — deployed by GitHub Actions on every push to `main` |
| Worker + Docker + Traefik (data plane) | Azure VM |
| PostgreSQL | Prisma Postgres |
| Redis | Upstash |

`.github/workflows/main_kindlydeploy.yml` builds and deploys the API automatically. Pushing
several commits in quick succession can produce overlapping deploys and a
`Conflict (CODE: 409)` — re-run the workflow.

The worker is **not** deployed by CI. It runs under a process manager on the VM and is
updated by pulling on that machine.

---

## Design decisions

**Zipball download instead of `git clone`.** Cloning needs git on the host and credential
plumbing for private repositories. A GitHub App installation token plus the zipball archive
API gets the exact commit with no git dependency and a short-lived credential.

**Cookie sessions instead of JWT.** `Session.tokenHash` stores a SHA hash; the raw token only
ever exists in the cookie. A leaked database therefore yields no usable sessions, and logout
is a real deletion rather than a token that stays valid until it expires.

**Traefik pinned to v3.6.** Traefik ≤ v3.5 hard-codes Docker API version 1.24, which Docker
29 rejects (`minimum supported API version is 1.40`). `DOCKER_API_VERSION` does **not**
override it. v3.6 was the first release that negotiates correctly — with anything older, no
routers are ever created and every health check 404s.

**Health checks use `node:http`, not `fetch`.** Node's `fetch` (undici) treats `Host` as a
forbidden header and silently discards it. Since Traefik routes purely by `Host`, a `fetch`
health check reaches the proxy with no matching router and always gets 404. `node:http`
honours the header. This one cost a long debugging session and is the reason
`src/utils/healthCheck.js` looks the way it does.

**Per-installation error tolerance.** `/api/github/repositories` fans out across
installations with individual `try`/`catch` rather than a bare `Promise.all` — one rejection
would otherwise discard every result. Installations that return 404 are stale and get purged
automatically.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Deployments stay `QUEUED` | The worker isn't running | Start `npm run worker` |
| `runDockerCommand is not defined` | Incomplete `docker.js` | Restore the helper in `src/utils/docker.js` |
| Health check returns `404` | Traefik has no router for the container | Confirm Traefik ≥ v3.6 and check its logs for Docker API errors |
| Health check `404` from the worker only, but `curl -H "Host: ..."` returns `200` | The `Host` header was dropped | Use `node:http`, never `fetch` |
| CORS blocked in the browser | `FRONTEND_URL` has a trailing slash | Remove it — browser `Origin` values never have one |
| `ACAO: *` with no `Allow-Credentials` | Azure's *platform* CORS is overriding Express | Clear it with `az webapp cors` **and restart the app** |
| `<!DOCTYPE ...is not valid JSON` in the frontend | The API is serving old code without the route | Wait for the deploy to finish, then hard-refresh |
| Not signed in after the OAuth redirect | Third-party cookie blocking (frontend and API on different sites) | Serve the API from a subdomain of the frontend's domain |
| `redirect_uri is not associated with this application` | Callback URL drift | Add the URL to the GitHub App — multiple are allowed |
| `Conflict (CODE: 409)` in Actions | Overlapping App Service deploys | Re-run the workflow |

---

<div align="center">

Built as a learning platform — the interesting part is the pipeline, not the UI.

**[Frontend repository →](https://github.com/garvit-arora/kindly-deploy-frontend)**

</div>
