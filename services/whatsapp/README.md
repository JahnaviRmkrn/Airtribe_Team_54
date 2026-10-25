# muop WhatsApp bridge

Long-lived Node process that holds each organiser's linked WhatsApp session
([Baileys](https://github.com/WhiskeySockets/Baileys) `6.7.24`, WhatsApp Web
multi-device protocol, the same mechanism `wacli` uses). A Next.js route cannot
hold websockets reliably, so the bridge is its own process:

```
browser --cookie--> Next (/api/me/whatsapp/*) --x-wa-bridge-secret--> 127.0.0.1:3010 bridge --> WhatsApp
```

- Listens **only on 127.0.0.1** (refuses to start otherwise). Every request needs the
  `x-wa-bridge-secret` header (constant-time compare). Only the Next server has it.
- This is an **unofficial client**. WhatsApp may restrict accounts that use it. The
  organiser sees that warning and must opt in before anything starts.
- One session per muop user id (must be a UUID; it names the directory, so anything
  else is rejected). Sessions and the synced contact list are AES-256-GCM sealed
  (`lib/secretbox.mjs`) in `WA_SESSION_DIR/<user id>/{auth,directory}.enc`, mode 0600,
  with a per-user, per-file key derived from `WA_SESSION_KEY`.
- On start the bridge reconnects every paired session on disk (never-paired leftovers
  are deleted), with exponential backoff (1 s to 60 s, 8 tries, then `error`).
  A 401 / logged-out from WhatsApp wipes that user's files and reports `logged_out`.
  "Replaced" (440) and "forbidden" (403) are not retried.
- Logs contain user ids, states and close codes only: never message text, numbers, JIDs
  or names. Baileys' own logger is off.
- Sends: synced contacts and groups only (or a number the Next server vouches is one of
  the user's muop contacts and that exists on WhatsApp), 25/hour and 1.5 s apart per
  user here, on top of Next's 20/hour per user.

## Environment

| Var | Required | Notes |
|---|---|---|
| `WA_BRIDGE_SECRET` | yes | >= 32 chars. Same value in the Next server's env. `openssl rand -hex 32` |
| `WA_SESSION_KEY` | yes | 32 bytes, 64 hex or base64. Same value in the Next server's env (it also seals SMS gateway credentials). Back it up: losing it makes saved sessions unreadable and everyone must relink. `openssl rand -hex 32` |
| `WA_SESSION_DIR` | no | default `~/.local/state/muop-whatsapp`. Keep it outside the repo |
| `WA_BRIDGE_PORT` | no | default `3010` |
| `WA_BRIDGE_URL` | Next side, no | default `http://127.0.0.1:3010` |

## Run

```bash
pnpm install                                   # repo root: installs the workspace incl. this service
WA_BRIDGE_SECRET=$(openssl rand -hex 32) WA_SESSION_KEY=$(openssl rand -hex 32) \
  pnpm --filter muop-whatsapp-bridge start
```

Baileys pulls `libsignal` from a git URL, so the root `pnpm-workspace.yaml` sets
`blockExoticSubdeps: false` and pins that dependency to an exact commit via `overrides`.

## Smoke test (links nothing)

```bash
pnpm --filter muop-whatsapp-bridge smoke
```

Boots the bridge on a random loopback port with throwaway secrets in a temp dir, checks
the secret is enforced, starts a link for a random user id and waits for WhatsApp's
servers to hand back a QR string (length printed, QR itself never printed), then deletes
everything. Needs outbound access to WhatsApp. Nobody scans the QR.

## HTTP API (bridge, loopback)

`POST /sessions/:uid/start {phone?}` · `GET /sessions/:uid/status` · `DELETE /sessions/:uid`
(logout + wipe) · `GET /sessions/:uid/contacts?q&limit&offset` · `POST /sessions/:uid/lookup {jids}`
· `GET /sessions/:uid/groups` · `POST /sessions/:uid/send {jid, text, via_contact?}` · `GET /health`.

## systemd --user unit (example, not installed)

`~/.config/systemd/user/muop-whatsapp.service`:

```ini
[Unit]
Description=muop WhatsApp bridge (loopback only)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/arvind/developer/Airtribe_Team_54/services/whatsapp
# KEY=value lines; chmod 600. Contains WA_BRIDGE_SECRET, WA_SESSION_KEY, optional WA_SESSION_DIR / WA_BRIDGE_PORT.
EnvironmentFile=%h/.config/muop/whatsapp.env
ExecStart=/usr/bin/node src/index.mjs
Restart=always
RestartSec=5
# Let a clean SIGTERM flush session writes before exit.
TimeoutStopSec=20
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=%h/.local/state/muop-whatsapp
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

[Install]
WantedBy=default.target
```

Then `systemctl --user daemon-reload && systemctl --user enable --now muop-whatsapp`.
The Next unit (`next start`) needs the same `WA_BRIDGE_SECRET` and `WA_SESSION_KEY` in its
environment, plus the migration `20261025100000_channel_links.sql` applied.

## SMS (Android gateway)

SMS needs no bridge process: Next calls the organiser's own phone running
[SMS Gateway for Android](https://sms-gate.app) directly.

- **Cloud mode:** install the app, switch on "Cloud Server", tap Offline to go Online, copy the
  username and password it shows into Messaging. muop POSTs to
  `https://api.sms-gate.app/3rdparty/v1/message` (override with `SMS_GATE_CLOUD_URL`).
- **Local server mode:** the phone's own server (`http://<phone>:8080/message`), reachable
  from this machine over LAN or Tailscale. The organiser supplies the URL, so muop refuses
  loopback, link-local/metadata, multicast and this machine's own addresses (re-checked at
  connect time against DNS rebinding), never follows redirects, and returns only generic
  errors. Set `SMS_LOCAL_MODE=off` to disable this mode entirely.
- Credentials are stored sealed in `channel_links.secret_enc` (service role only) with the
  same `WA_SESSION_KEY`, are write-only, and are deleted on unlink.
- Inbound SMS (the gateway's `sms:received` webhook) is **not** implemented; follow-up.

## Known limits

- Contacts come from WhatsApp's app-state sync plus recent history and push names.
  `syncFullHistory` is off because WhatsApp drops the pairing handshake with it on 6.7.24.
  A just-linked account may take a minute to show contacts; people with no saved name show
  their number or WhatsApp profile name.
- Contacts that WhatsApp identifies only by a `@lid` id have no phone number.
- Single bridge process, no HA. Sessions reconnect on restart.
