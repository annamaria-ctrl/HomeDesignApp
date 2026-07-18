# Home Design App

A browser-based home/interior design planner: draw a floor plan in 2D, place furniture from a built-in library, and view the result in 3D or walk through it in first person. Projects are saved to the cloud (Supabase) under each user's own account.

## Features

- **2D editor** — draw walls, doors, windows, dimension lines.
- **3D view** — orbit around the model; realistic per-room lighting, an optional ceiling, and room floor textures.
- **Walkthrough** — first-person WASD movement with mouse-look and collision against walls and furniture.
- **Furniture library** — a curated catalog (seating, tables, storage, beds, kitchen, bathroom, decor) with per-item color/size editing and wall/furniture collision avoidance when placing or dragging.
- **Accounts & cloud projects** — sign up, save any number of projects to your account, reload them from any browser. A local `.json` export/import is also available as a manual backup.

## Tech stack

React 19 + TypeScript + Vite, Tailwind CSS v4, Zustand v5, Three.js via `@react-three/fiber`/`drei`, Supabase (Postgres + Auth).

## Local development

```bash
npm install
cp .env.example .env   # fill in your Supabase project URL + anon key
npm run dev
```

Without `.env` configured, the app shows a "cloud storage isn't set up" screen instead of the editor — see [DEPLOY.md](./DEPLOY.md) for how to create a Supabase project and run the schema migration.

## Scripts

- `npm run dev` — start the dev server
- `npm run build` — typecheck (`tsc -b`) and build for production
- `npm run lint` — run Oxlint
- `npm run preview` — preview the production build locally

## Deployment

See [DEPLOY.md](./DEPLOY.md) for the full Supabase + Vercel setup walkthrough.
