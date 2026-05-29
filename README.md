# Imitation Jewellery Manufacturing ERP

A modern, scalable ERP for an imitation jewellery manufacturing company, built as a
**monorepo**: a **NestJS + Prisma** REST API and a **Next.js 15 + Tailwind** admin
dashboard. **Phase 1** ships three master modules — **Vendor Master**,
**Material Variant Master**, and **Item Master** — on an architecture designed to
absorb Production Orders, Inventory, BOM, Purchase Orders, Job-Work Tracking and
Dispatch in later phases.

```
pratik_products_erp/
├── backend/     NestJS 10 · Prisma · MySQL · JWT auth · local file uploads
└── frontend/    Next.js 15 (App Router) · TypeScript · TailwindCSS · shadcn-style UI
                 React Hook Form + Zod · TanStack Table · TanStack Query
```

---

## Tech stack

| Layer    | Technology |
|----------|------------|
| Frontend | Next.js 15, React 18, TypeScript, TailwindCSS, shadcn-style components, React Hook Form, Zod, TanStack Table, TanStack Query, sonner (toasts), lucide-react |
| Backend  | NestJS 10, TypeScript, Prisma ORM, class-validator, Passport-JWT, Multer |
| Database | MySQL 8 / MariaDB 10.4+ |
| Auth     | JWT (Bearer token) |
| Uploads  | Local disk (`backend/uploads`), served at `/uploads/*` |

---

## Prerequisites

- **Node.js 18+**
- **MySQL / MariaDB** running (XAMPP is fine — start MySQL from the control panel)

---

## Setup

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env          # adjust DATABASE_URL / JWT_SECRET if needed
```

`.env` defaults (XAMPP MySQL, separate DB so it won't touch any existing one):

```
DATABASE_URL="mysql://root:@127.0.0.1:3306/jewellery_erp_next"
PORT=4000
CORS_ORIGIN="http://localhost:3000"
JWT_SECRET="change-me"
```

Create the schema and seed the admin user + master data:

```bash
npx prisma db push      # creates tables from prisma/schema.prisma
npm run prisma:seed     # admin / admin123 + processes + categories
npm run start:dev       # API on http://localhost:4000/api
```

> First create the database once if it doesn't exist:
> `CREATE DATABASE jewellery_erp_next;`

### 2. Frontend

```bash
cd frontend
npm install               # use --legacy-peer-deps if your npm is strict
# .env.local already points at the API:
#   NEXT_PUBLIC_API_URL=http://localhost:4000/api
#   NEXT_PUBLIC_FILE_BASE=http://localhost:4000
npm run dev               # app on http://localhost:3000
```

Open **http://localhost:3000** → login **`admin` / `admin123`**.

---

## Architecture notes (forward-looking)

### Two code systems — modelled separately
- **Internal Design Code** → `Item.internalDesignCode` (company-wide unique, e.g. `D102`).
- **Vendor Reference Code** → the vendor's *own* code for a design/variant:
  - `ItemProcessVendor.vendorDesignReference` (e.g. Casting → `CST-88`, Plating → `PL-902`).
  - `MaterialVariantVendor.vendorReference` for materials.
- **`Vendor.vendorCode`** (`V0001`) is the company's internal id for the vendor record — *not* a design reference.

### Multiple vendors per process
`ItemProcessVendor` is a true many-relation: one process (e.g. Plating) lists several
vendor options, each with its own reference, cost and a `isPreferred` flag — ready for
"select preferred vendor per production batch" later.

### EAV process attributes
`ItemProcessAttribute` stores process-specific fields (weight, metal_type, plating_color,
polish_type, color_type) without schema churn as new processes/fields appear.

### Draft-friendly Item Master
Only `internalDesignCode` is required. Everything else is optional; `sampleStatus`
drives the lifecycle: Draft → In Development → Sample Ready → Production Ready.

### BOM scaffold (not built)
`ItemMaterial` (variant, quantity, unit, wastagePercent) exists so future Production
Orders can multiply quantities and source vendor-wise. No BOM calc/UI in Phase 1.

### Reusable infrastructure
Generic `FileAsset` registry, `StatusHistory` audit trail and a master `Process` table
all anticipate later modules.

---

## API (REST, JSON, JWT)

All responses are wrapped as `{ success: true, data }`; errors as
`{ success: false, message, errors? }`. Send `Authorization: Bearer <token>`.

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/auth/login` | login → `{ token, user }` |
| GET | `/api/auth/me` | current user |
| GET | `/api/processes` | process master (+ attribute schema) |
| GET/POST | `/api/vendors` · `/api/vendors/:id` (GET/PUT/DELETE) | Vendor CRUD |
| GET | `/api/materials/categories` · `/api/materials/list` | dropdown data |
| GET/POST | `/api/materials/variants` · `/api/materials/variants/:id` | Variant CRUD |
| GET | `/api/items/meta` | processes + vendors-by-process for the form |
| GET/POST | `/api/items` · `/api/items/:id` (GET/PUT/DELETE) | Item CRUD |
| DELETE | `/api/items/:id/images/:imageId` | remove a product image |
| POST | `/api/uploads?module=&type=image\|cad` | upload a file → `{ path, url }` |

**Upload flow:** the frontend uploads files first (`/uploads`), then submits the
returned relative paths inside the JSON create/update body. This keeps CRUD endpoints
pure JSON and easy to consume from React (and later from any client).

---

## Scripts

**backend**: `start:dev`, `build`, `start:prod`, `prisma:generate`, `prisma:push`,
`prisma:seed`, `db:setup` (push + seed), `typecheck`
**frontend**: `dev`, `build`, `start`, `typecheck`, `lint`

---

## Phase 1 status

| Module | Status |
|--------|--------|
| JWT auth + dashboard | Done |
| Vendor Master (CRUD, processes, search/filter, dialog form) | Done |
| Material Variant Master (CRUD, image upload, responsive vendor mapping) | Done |
| Item Master (multi-step form, process accordions, multi-vendor, drafts, images, CAD, blueprint detail) | Done |

**Not in Phase 1 (schema-ready):** Inventory · Production Orders · Accounts · Billing ·
Purchase Orders · Analytics · Dispatch · Job-Work Tracking · BOM calculations.
