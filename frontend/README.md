# OrbitPane frontend

OrbitPane's frontend is a React and Vite progressive web app for working with
self-hosted coding agents. It uses the shared authenticated REST client in
`src/lib/api.ts` and an authenticated WebSocket for realtime agent events.

## Development

```bash
npm ci
npm run dev
```

## Verification

```bash
npm run lint
npm run build
```

Production assets are written to `dist/` and served by Nginx at
`https://orbitpane.hzycode.com`.
