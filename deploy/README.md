# Deploying ToolMint to the VPS

Runs as its own isolated Docker Compose stack — own network (`toolmint_net`),
own volumes (`toolmint_postgres_data`, `toolmint_redis_data`,
`toolmint_minio_data`), own containers (`toolmint-*`), own folder on disk.
Nothing here reads, writes, or shares a network with whatever else is
already running on this machine. The only thing that changes outside this
folder is one new nginx config file (`deploy/nginx/toolmint.conf`), added
alongside — not merged into — your existing site configs.

## 0. Before you start

Confirm the ports this stack wants are actually free (`127.0.0.1:38173`,
`127.0.0.1:4100`, `127.0.0.1:9100` — all localhost-only, so this only
matters if something else on the box already grabbed them). During
development this box turned out to have several other sites' `next-server`
processes already bound to low, guessable ports (3100, then 3200) — hence
the odd-looking high port here, chosen only after confirming it was clear.
Treat a bind failure at `up` time as real even if this check said clear
earlier — it can still lose a race to something started later:

```bash
sudo ss -tlnp | grep -E ':38173|:4100|:9100'
```

If any of those print a result, edit the three port lines in
`deploy/docker-compose.prod.yml` (and the matching `proxy_pass` line in
`deploy/nginx/toolmint.conf`) to a free port instead, consistently in both
places.

Confirm Docker is installed (`docker --version`, `docker compose version`
— if either command is missing, install Docker Engine + the Compose plugin
first; this repo doesn't script that part since it varies by distro).

## 1. Get the code onto the VPS

```bash
git clone <this-repo-url> /opt/toolmint
cd /opt/toolmint
```

(`/opt/toolmint` — or anywhere else you like, as long as it's a fresh
directory, not reused from another project.)

## 2. Fill in production secrets

```bash
cp deploy/.env.prod.example deploy/.env.prod
```

Edit `deploy/.env.prod` and generate a real value for every blank —
`openssl rand -base64 32` for each. **Do not reuse the placeholder values
from `apps/api/.env.example`** (those are dev-only, and are essentially
public since they're committed to the repo).

## 3. Build and start the stack

```bash
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod up -d --build
```

This is the step most likely to need a fix on the first try — the
Dockerfiles were written carefully but couldn't be build-tested locally
(Docker itself is broken on the machine this repo was developed on, which
is a separate, Windows-specific problem that doesn't apply here). If the
build fails, paste the error and it can be fixed from there.

Once it's up:

```bash
docker compose -f deploy/docker-compose.prod.yml ps
# all of toolmint-postgres, toolmint-redis, toolmint-minio, toolmint-api,
# toolmint-web should show "healthy" or "running"; toolmint-minio-init
# should show "exited (0)" — it's a one-shot setup job, not a service.

curl http://127.0.0.1:4100/health
# {"status":"ok",...} confirms the API reached Postgres.
```

## 4. Wire up nginx

```bash
sudo cp deploy/nginx/toolmint.conf /etc/nginx/sites-available/toolmint.conf
sudo ln -s /etc/nginx/sites-available/toolmint.conf /etc/nginx/sites-enabled/toolmint.conf
sudo nginx -t   # check it parses before reloading
sudo systemctl reload nginx
```

`nginx -t` is the safety net here — it validates the *entire* nginx config,
including your existing sites, before anything reloads. If it fails, nginx
tells you which file and line; nothing gets applied until it passes, so
your other sites are never at risk from this step.

## 5. DNS

At your registrar's DNS panel for `toolmint.co.in`, add three `A` records
(or `AAAA` if the VPS's IP is v6) all pointing at the VPS's IP:

| Host | Type | Value |
|---|---|---|
| `www` | A | `<vps-ip>` |
| `api` | A | `<vps-ip>` |
| `media` | A | `<vps-ip>` |
| `@` (apex) | A | `<vps-ip>` (optional — lets bare `toolmint.co.in` resolve too) |

DNS propagation can take anywhere from a few minutes to a few hours.

## 6. HTTPS

```bash
sudo certbot --nginx -d www.toolmint.co.in -d api.toolmint.co.in -d media.toolmint.co.in -d toolmint.co.in
```

(Drop `-d toolmint.co.in` if you skipped the apex DNS record.) certbot's
nginx plugin edits `toolmint.conf` in place to add the certificates and an
HTTP→HTTPS redirect — nothing to do manually here beyond running it.

## 7. Run the database migration

```bash
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod exec -w /app/apps/api api npx prisma migrate deploy
```

(The `-w /app/apps/api` matters — npm workspaces places the `prisma` CLI
binary under `apps/api/node_modules/.bin`, not the container's default
`/app` working directory, so `npx` can't find it without being pointed
there explicitly.)

(Only needed once per schema change going forward — this first run creates
every table.)

## 8. Verify it's actually live

- `https://api.toolmint.co.in/health` → `{"status":"ok",...}`
- Register a real account at `https://www.toolmint.co.in`, upload a real
  video clip, place it on a timeline, and export — a scene that reaches
  `Ready` with a working download link is the real end-to-end proof this
  is working, not just that the pages load.

## Before real users touch it

`MailService`'s only implementation today logs verification/reset emails to
the container's stdout (`docker compose -f deploy/docker-compose.prod.yml
logs api`) rather than sending them — implement a real provider before
launch, or "forgot password" silently does nothing a user can see. See the
main README's "Auth" section for where that adapter lives.

## Updating after a code change

```bash
cd /opt/toolmint
git pull
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod up -d --build
```

Add `docker compose -f deploy/docker-compose.prod.yml --env-file
deploy/.env.prod exec -w /app/apps/api api npx prisma migrate deploy`
afterward if the change included a schema migration.

## Test instance (no login required)

A second, throwaway stack — `docker-compose.test.yml` — for clicking
through the app without registering or logging in. It's fully separate
from production: own network, own volumes, own Postgres/Redis/MinIO, no
nginx block, no DNS record. Every port is bound to `127.0.0.1` only, so
it's reachable *exclusively* through an SSH tunnel — not the public
internet, not even the VPS's own IP from outside.

The API runs with `DISABLE_AUTH=true`, which only kicks in when a browser
has no session cookie at all (see `refresh()` in `auth.service.ts`) — the
first page load auto-creates a fixed "Test User" account and logs in as
them. This flag must never be set on `docker-compose.prod.yml`.

**One-time setup**, from the VPS:

```bash
sudo ss -tlnp | grep -E ':41200|:41300|:41400'
```

If that prints anything, one of these three ports collided with something
else on the box (same failure mode documented in Step 0 above) — pick a
different port, edit it consistently across `docker-compose.test.yml`'s
three `ports:` lines *and* its `S3_ENDPOINT` / `WEB_APP_URL` /
`NEXT_PUBLIC_API_URL` values (they all bake in the port number), then
re-check. If it's silent, continue:

```bash
cp deploy/.env.test.example deploy/.env.test
# edit deploy/.env.test and fill in every blank with openssl rand -base64 32
docker compose -f deploy/docker-compose.test.yml --env-file deploy/.env.test up -d --build
```

**Every time you want to use it**, from your own machine (not the VPS):

```bash
ssh -L 41200:127.0.0.1:41200 -L 41300:127.0.0.1:41300 -L 41400:127.0.0.1:41400 root@200.141.0.198
```

Leave that terminal open, then visit `http://localhost:41300` in a
browser — it logs you straight into the dashboard as "Test User", no
account needed. Closing the SSH session ends access immediately.

**To tear it down** once you're done testing:

```bash
docker compose -f deploy/docker-compose.test.yml down -v
```

The `-v` also deletes its Postgres/Redis/MinIO volumes — fine here since
it's throwaway data, but never run that against `docker-compose.prod.yml`.

## Continuous deployment (optional)

`.github/workflows/deploy.yml` runs the update steps above automatically on
every push to `main` — no manual VPS commands after that point. One-time
setup, done once on the VPS and once on GitHub:

**On the VPS**, generate a dedicated key pair just for this (don't reuse
your personal one):

```bash
ssh-keygen -t ed25519 -f ~/.ssh/toolmint_deploy -N "" -C "github-actions-deploy"
cat ~/.ssh/toolmint_deploy.pub >> ~/.ssh/authorized_keys
cat ~/.ssh/toolmint_deploy
```

That last command prints the *private* key. Copy the whole block, including
the `-----BEGIN...` and `-----END...` lines.

**On GitHub**, go to the repo's Settings -> Secrets and variables -> Actions
-> "New repository secret", and add three secrets:

| Name | Value |
|---|---|
| `VPS_HOST` | the VPS's IP address |
| `VPS_USER` | `root` (or whichever user owns `/opt/toolmint`) |
| `VPS_SSH_KEY` | the private key printed above, pasted in full |

Paste the private key directly from the VPS terminal into GitHub's secret
field — it's encrypted at rest and never exposed in logs. It doesn't need
to pass through anywhere else, including any AI assistant helping with
setup, since GitHub Actions is the only thing that ever uses it.

From then on, every push to `main` (including one made by Claude on your
behalf) redeploys automatically — check progress under the repo's
"Actions" tab.
