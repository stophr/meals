# meals

Recipe-first household grocery planner with a **time-vs-savings** deal optimizer.
Plan meals → generate a shopping list (minus pantry stock) → the optimizer picks which
store(s) to buy each item at, balancing money saved against travel time. Prices come from
manual entry and **local, offline receipt OCR** (Ollama vision model — no cloud calls).

## Quickstart (Docker)

```bash
ollama pull qwen2.5vl:3b        # local OCR model (optional but recommended)
cp .env.example .env            # defaults work out of the box
docker compose up -d --build    # postgres + api + web
docker compose exec api pnpm --filter @meals/db seed   # demo data
```

Open **http://localhost:8090** — or from your phone on the same network,
**http://\<this-machine's-IP\>:8090** (find it with `hostname -I`). The web container
proxies `/api/*` to the API, so no extra config is needed for LAN devices.

Port taken? Override in `.env`: `WEB_PORT=…`, `API_HOST_PORT=…`, `POSTGRES_HOST_PORT=…`.

> **Receipt OCR from Docker:** the API reaches Ollama on the host via `host.docker.internal`.
> Ollama must listen beyond loopback: `OLLAMA_HOST=0.0.0.0 ollama serve`.
> See `docs/local-ocr.md` for model choices, vLLM, and tuning.

**Want a massive recipe catalog?** Bulk-import ~275K star-rated Food.com recipes —
see `docs/foodcom-import.md` (one download + one command, idempotent).

## Local development

```bash
pnpm install
docker compose up -d postgres
pnpm --filter @meals/db push && pnpm db:seed
pnpm dev            # api :3001 (tsx watch) + web :5173 (vite)
pnpm -r typecheck && pnpm -r test
```

## Layout

```
apps/api        Fastify REST (+ OCR ingest & review queue)     apps/web   React PWA (mobile-first)
packages/db     Prisma schema + client                         packages/shared  zod DTOs, unit math, API client
packages/core   optimizer, unit normalization, fuzzy matcher   packages/ingestion  OCR providers (local | claude), scraper iface
```

Data model crux: `CanonicalItem` (store-agnostic concept) vs `ProviderProduct` (a store's
listing; prices attach here). All quantities stored twice — as entered and normalized to a
base unit (g / ml / each) — so price comparison and the optimizer run on base units.
