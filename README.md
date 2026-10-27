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
PostgreSQL schema migrations are checked in under `prisma/migrations`, including
the task comments and attachment tables.
The Vercel-compatible function entry point is `api/index.ts`.

### Push notifications

The backend sends standards-based Web Push notifications through VAPID. Reuse
the existing `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` values
in the backend environment; do not generate a replacement key pair. Keep the
private key exclusively in backend/server configuration. The authenticated
frontend obtains only the public key from `GET /api/notifications/push/config`.
Never add either private VAPID or Supabase service-role credentials to Angular
configuration or `public/app-config.js`.

Push subscriptions are owned by the authenticated user. The notification
center lets a user enable/disable this device and choose push categories for
Tasks, Reminders, Requests, and Meetings. These category preferences do not
disable or remove in-app notifications. Event records are deduplicated per user
and event; push deliveries use retryable claims and remove subscriptions that a
push provider reports as expired. Tapping a push opens the associated item (or
the relevant list for deleted items).

Event notifications created through the shared notification service trigger
push dispatch immediately; the Cron job remains responsible for scheduled due
reminders, meeting reminders scheduled within 15 minutes, and retrying queued
deliveries. The current `vercel.json` schedule calls the protected
`GET /api/notifications/push/dispatch` endpoint daily at 09:00 UTC, so scheduled
reminders and retries follow that cadence. Set `CRON_SECRET` to a separate long
random value; the endpoint requires the matching bearer token.
`CRON_SECRET` is present in `.env.example` but is not currently configured in
the local backend `.env`; set it there to test the protected dispatcher locally.
The production Cron must be enabled in Vercel. Set `REMINDER_TIMEZONE` to the
IANA timezone used for reminder and meeting schedule calculations (defaults to
`Africa/Lagos`).

Apply all pending Prisma migrations with `npm run prisma:migrate:deploy` before
deploying. The Web Push migration creates the per-user subscription and
idempotency queue tables; the notification preferences migration adds
per-user category controls and task update/status notification types. No
Supabase Edge Function or client-side database access is used: notifications
are written by the existing authenticated NestJS/Prisma backend, with the
Supabase Postgres database as its data store.

Push notifications require HTTPS and an installed/accepted PWA on supported
browsers. On iOS, Web Push is available to web apps added to the Home Screen
with iOS/iPadOS 16.4 or later. Android and desktop delivery also depends on
browser/OS support, connectivity, and user permission. The user must enable
notifications from the Notifications page after signing in. Without the
existing VAPID configuration, push subscription is reported as unavailable;
in-app notifications continue to work.

Tasks support comments at `GET/POST /tasks/:id/comments` and file metadata at
`GET /tasks/:id/attachments`. Upload with multipart field `file` to
`POST /tasks/:id/attachments` and download an attachment from
`GET /tasks/:id/attachments/:attachmentId`. Attachments are limited to 4 MB and
only PDF, DOC, and DOCX files are accepted. File bytes are stored in a private
Supabase Storage bucket; PostgreSQL stores attachment metadata and the object
path. Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and optionally
`SUPABASE_STORAGE_BUCKET` in the backend environment, and create the bucket
privately in Supabase Storage. In non-production local development, if these
Supabase values are omitted, files are stored under the ignored
`.task-attachments` directory and are still served only by the authenticated
download endpoint. Never put the service-role key in frontend configuration.
Existing attachment records from the earlier database-storage implementation
retain their bytes and remain downloadable; new files use object storage.
Apply pending migrations with `npm run prisma:migrate:deploy` before using these
endpoints. Task assignees can start pending tasks and complete in-progress
tasks; users with `tasks:write` retain management access.

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
  For example, use `https://executive-reminder-frontend.vercel.app` with no
  trailing path; separate multiple allowed origins with commas.
- `SUPABASE_URL`: the Supabase project URL used for private file storage.
- `SUPABASE_SERVICE_ROLE_KEY`: a backend-only service-role key for private
  Storage access; never expose it to the frontend.
- `SUPABASE_STORAGE_BUCKET`: optional private bucket name (defaults to
  `task-attachments`).
- `VAPID_PUBLIC_KEY`: the existing Web Push public key; it is exposed only by
  the push configuration endpoint for subscription registration.
- `VAPID_PRIVATE_KEY`: the matching existing Web Push private key; backend-only.
- `VAPID_SUBJECT`: the existing VAPID contact URI, for example a `mailto:` URI.
- `CRON_SECRET`: a separate long random secret used to authorize the scheduled
  push/reminder dispatch endpoint.
- `REMINDER_TIMEZONE`: optional IANA timezone for scheduled reminder and
  meeting calculations (defaults to `Africa/Lagos`).

The Vercel handler answers valid CORS preflight requests without starting Nest
or connecting to the database. Login and other API operations still require a
reachable production `DATABASE_URL`; check the Vercel function logs and
Supabase pooler availability if those requests return 503 or 504 responses.

Copy the connection strings from Supabase Dashboard → Connect. The Supabase
project URL and publishable key you provided are not used by this Prisma
backend; they are for Supabase client APIs. Do not use
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` as `DATABASE_URL`; that key is for
Supabase client access and is not a database credential. Do not commit either
database connection string or any database password.

After setting the variables locally, run `npm run prisma:migrate:deploy` once
with the Production `DIRECT_URL`, optionally run `npm run prisma:seed`, then
redeploy so the function receives the runtime variables and the production
deployment activates its configured cron schedule. Copy the already-generated
VAPID key pair from secure server-side configuration; do not generate or
commit another pair. The checked-in Prisma migrations are stored in
`prisma/migrations`.
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
