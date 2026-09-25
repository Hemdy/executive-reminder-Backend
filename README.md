# Executive Reminder API

NestJS, Prisma and TypeScript backend for the Angular Executive Reminder application.

## Setup
Copy `.env.example` to `.env`, replace its placeholders with your local values,
and install dependencies (`npm install`). Then run `npm run prisma:generate`,
`npm run prisma:migrate:deploy`, optionally `npm run prisma:seed`, and
`npm run start:dev`. The demo account is `demo@example.com` /
`ChangeMe123!`; change it immediately in a real environment.

To create the initial ADMIN account without running the destructive demo seed,
set `ADMIN_PASSWORD` in the environment and run
`npm run prisma:admin:create`. The command uses bcrypt with the same cost as
authentication, grants the seeded application permissions, and leaves an
existing `admin@example.com` account unchanged. On Windows PowerShell, set the
password without echoing it, run the command, and remove the environment value:

```powershell
$securePassword = Read-Host "Admin password" -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
  $env:ADMIN_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
  npm run prisma:admin:create
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
  Remove-Item Env:ADMIN_PASSWORD -ErrorAction SilentlyContinue
}
```

## API
`POST /auth/login` returns a JWT. Send it as `Authorization: Bearer <token>`.
Protected CRUD endpoints are `/tasks`, `/reminders`, `/requests`, `/meetings`, and
`/notifications`; each has a resource-specific `PATCH :id/status` where applicable,
and notifications support `PATCH :id/read` and `PATCH /read-all`. Administrators with
`admin:users` can list, create, update, deactivate, and delete users and roles at
`/admin/users` and `/admin/roles` (including the `/active` endpoints). User and role
records include `isActive`; password hashes are never returned by admin endpoints.
DTOs reject unknown fields.
Roles accept arbitrary `name`, optional `description`, and permissions as
`{ "action": "read", "resource": "tasks" }`; permission authorization consistently
uses the `resource:action` identifier (for example `tasks:read`).
The initial PostgreSQL schema migration is checked in under `prisma/migrations`.
The Vercel-compatible function entry point is `api/index.ts`.

### Vercel deployment

Set these environment variables in the Vercel project for the Production,
Preview, and Development environments as appropriate:

- `DATABASE_URL`: the Supabase Transaction Pooler connection string. Include
  `pgbouncer=true` when using port `6543`; this is the runtime connection used
  by Vercel.
- `DIRECT_URL`: the Supabase direct database connection string on port `5432`.
  Prisma uses this for migrations and schema operations.
- `JWT_SECRET`: a long, random secret used to sign access tokens.
- `JWT_EXPIRES_IN`: optional token lifetime such as `1d`.
- `FRONTEND_ORIGIN`: the deployed frontend origin, including its scheme.

Copy the connection strings from Supabase Dashboard → Connect. The Supabase
project URL and publishable key you provided are not used by this Prisma
backend; they are for Supabase client APIs. Do not use
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` as `DATABASE_URL`; that key is for
Supabase client access and is not a database credential. Do not commit either
database connection string or any database password.

After setting the variables locally, run `npm run prisma:migrate:deploy` once
with the Production `DIRECT_URL`, optionally run `npm run prisma:seed`, then
redeploy so the function receives the runtime variables. The initial migration
is stored in `prisma/migrations`.
The API routes are served below `/api` (for example, `POST /api/auth/login`).

### Local frontend-to-database test

1. Copy `.env.example` to `.env` and replace its URL and JWT placeholders with
   the values from Supabase Dashboard → Connect. Keep `.env` out of source
   control. Use a transaction-pooler URL for `DATABASE_URL` and the direct
   database URL for `DIRECT_URL`.
2. From this backend folder, run `npm install`, `npm run prisma:generate`,
   `npm run prisma:migrate:deploy`, and optionally `npm run prisma:seed`.
   `migrate:deploy` applies the checked-in PostgreSQL migration; do not run it
   against a database containing pre-existing tables without first reconciling
   its schema and migration history.
3. Start the API with `npm run start:dev` (port `3000` by default).
4. In the frontend folder, run `npm install` and `npm start`. The Angular
   development proxy forwards `/api` calls on port `4200` to the backend.
   For deployment, set the public API base URL in `public/app-config.js` or
   serve the frontend and `/api` through the same origin. This file must never
   contain database URLs, JWT secrets, or other credentials.
5. Sign in, then create and edit a task, reminder, request, or meeting. Confirm
   that the new data remains after reloading the page and that the API
   responses appear in the UI. The frontend includes the JWT from login on
   protected API requests.

The checked-in `.env.example` contains placeholders only. Keep actual Supabase
connection strings and JWT secrets in the backend's ignored `.env` file or
deployment environment settings, never in frontend configuration.
