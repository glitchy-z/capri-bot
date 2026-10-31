# Hosting capri-bot with Docker

Everything works in Docker except `!hd`'s AI upscale (the model is a Windows
exe — in Docker, `!hd` automatically falls back to the lanczos upscaler).

## Fresh deploy on a VPS (Ubuntu/Debian)

```bash
# once, on the server
curl -fsSL https://get.docker.com | sh

# copy this folder to the server (scp, git, whatever), then inside it:
docker compose up -d --build
docker logs -f capri-bot        # scan the QR with WhatsApp (Linked devices)
```

The session saves into `data/auth_state` — after the first scan the bot
survives restarts and rebuilds with no new QR. `docker compose logs -f`
shows new QRs whenever one is needed.

## Moving THIS machine's session to the server (no re-scan)

1. Stop the Windows bot first: `npm run stop` in this folder.
   Never run two hosts on one session — they'll fight over the connection.
2. Copy the `auth_state` folder from this directory into `data/auth_state`
   on the server.
3. `docker compose up -d --build` — she comes up already logged in.

## Notes

- `config.json` and `cookies.txt` are bind-mounted — edit them on the host
  and restart with `docker compose restart`.
- Chat memory lives in `data/bridge/chat_memory.json` (persists).
- `docker compose up -d --build` rebuilds after any `bot.js` change.
- The container restarts itself on crash and on server reboot
  (`restart: unless-stopped`).
- If WhatsApp drops messages again, re-linking fresh (delete
  `data/auth_state`, restart, new QR) usually fixes chronic sync issues.
