# fly-power worker

Cloudflare Worker control plane for Fly Machine power actions:

- `GET /status`
- `POST /start` (optional `?wait=1`)
- `POST /stop`

All endpoints require:

- `Authorization: Bearer <SHORTCUT_TOKEN>`

The worker also runs a daily cron trigger to stop the app at **12:00 AEST** (fixed year-round):

- cron expression: `0 2 * * *` (UTC)

## 1) Prerequisites

- Cloudflare account with Workers enabled
- Fly app already deployed (`openclaw-drevan`)
- Fly API token with permission to manage Machines

## 2) Configure

From this directory:

```bash
cd workers/fly-power
```

Login and set secrets:

```bash
npx wrangler login
npx wrangler secret put FLY_API_TOKEN
npx wrangler secret put SHORTCUT_TOKEN
```

`wrangler.toml` already sets:

- `FLY_APP_NAME = "openclaw-drevan"`
- `AUTO_STOP_ENABLED = "true"`
- cron trigger `0 2 * * *`

## 3) Deploy

```bash
npx wrangler deploy
```

Wrangler prints the Worker URL, like:

- `https://openclaw-fly-power.<subdomain>.workers.dev`

## 4) Test

```bash
BASE="https://openclaw-fly-power.<subdomain>.workers.dev"
TOKEN="<SHORTCUT_TOKEN>"

curl -sS "$BASE/status" -H "Authorization: Bearer $TOKEN"
curl -sS -X POST "$BASE/stop" -H "Authorization: Bearer $TOKEN"
curl -sS -X POST "$BASE/start?wait=1" -H "Authorization: Bearer $TOKEN"
```

Local cron simulation:

```bash
npx wrangler dev
curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=0+2+*+*+*"
```

## 5) Siri Shortcuts

Create three shortcuts with `Get Contents of URL`:

- **Start OpenClaw**
  - URL: `https://<worker-domain>/start?wait=1`
  - Method: `POST`
  - Header: `Authorization: Bearer <SHORTCUT_TOKEN>`
- **Stop OpenClaw**
  - URL: `https://<worker-domain>/stop`
  - Method: `POST`
  - Header: `Authorization: Bearer <SHORTCUT_TOKEN>`
- **OpenClaw Status**
  - URL: `https://<worker-domain>/status`
  - Method: `GET`
  - Header: `Authorization: Bearer <SHORTCUT_TOKEN>`

Optional: add `Speak Text` action using the JSON result.
