# ThreatReady — InterviewPrep

Personalised AI mock interviews: upload a resume and a job description, confirm what was
extracted, configure the interview, and answer an animated 3D interviewer whose questions adapt to
your answers. A worker scores the session against rubrics and produces a saved report.

Built to the ThreatReady Architecture Decision Document (9 Oct 2026): NestJS modular monolith
(`api` and `worker` roles from one image), Vite React SPA, PostgreSQL with RLS via Drizzle, pg-boss,
S3, Better Auth, and Anthropic only through `LlmPort`.

* Design, architecture mapping, API, scoring, security, cost: [docs/interviewprep.md](docs/interviewprep.md)
* API contract: [packages/contracts/openapi.json](packages/contracts/openapi.json) (generated from Zod)
* Configuration: [.env.example](.env.example)
* Sign-in: there is none here. The app runs at interviewprep.threatready.io and uses the shared ThreatReady session from onboard.threatready.io (`IDENTITY_URL`, `INTERNAL_API_TOKEN`, `ONBOARD_URL`). Onboard reads `/internal/v1/*` for the unified profile and the admin console's token and cost figures. See `../README.md`.

```bash
docker compose -f docker-compose.dev.yml up -d   # PostgreSQL 16
npm ci
npm run build                                     # packages, API, web
npm run lint && npm run typecheck && npm test
```
