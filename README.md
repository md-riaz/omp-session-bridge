# OMP Session Bridge

OMP extension that exposes active session status, events, and remote prompt queue through local HTTP/SSE API.

## Install

Install from GitHub:

```bash
omp install https://github.com/md-riaz/omp-session-bridge.git
```

Restart OMP, then run:

```text
/bridge
/bridge start
/bridge info
```

## Config

Created automatically:

```text
~/.pi/agent/omp-session-bridge/config.json
```

Default server:

```text
http://127.0.0.1:17979
```

Token is in config file.

## API

All routes except `/` require `Authorization: Bearer <token>` or `?token=<token>`.

- `GET /api/health`
- `GET /api/snapshot`
- `GET /api/stream`
- `POST /api/register`
- `POST /api/unregister`
- `POST /api/presence`
- `POST /api/event`
- `POST /api/send`
- `GET /api/poll`

Send prompt to session:

```bash
curl -X POST "http://127.0.0.1:17979/api/send" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"<session-id>","text":"hello from bridge"}'
```
