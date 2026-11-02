# Executive Reminder API

NestJS, Prisma and TypeScript backend for the Angular Executive Reminder application.

## Setup
Copy `.env.example` to `.env`, replace its placeholders with your local values,
and install dependencies (`npm install`). Then run `npm run prisma:generate`,
`npm run prisma:migrate:deploy`, and `npm run start:dev`. Only run
`npm run prisma:seed` against a disposable database: the demo seed deletes
existing application data. Never run it against production or a migration
target. The demo account is `demo@example.com` / `ChangeMe123!`; change it
immediately in a real environment.

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
uses the `resource:action` identifier (for example `tasks:read`). All non-`ADMIN`
roles are automatically granted `tasks:write`, `meetings:write`, `requests:write`,
and `reminders:write`; this applies to existing roles at startup and to roles
created or edited through the admin API. Other permissions remain role-configurable.
PostgreSQL schema migrations are checked in under `prisma/migrations`, including
the task comments and attachment tables.
The Vercel-compatible function entry point is `api/index.ts`.

### Supabase-to-Neon database migration

The Prisma datasource already uses PostgreSQL and separates the runtime
`DATABASE_URL` from the migration `DIRECT_URL`; no schema or database-driver
change is required for Neon. Use Neon's **pooled** connection URL for
`DATABASE_URL` and its **direct/unpooled** URL for `DIRECT_URL`, backups,
restores, and Prisma migrations. Keep `sslmode=require` in both URLs. Do not
put connection strings in source control, frontend configuration, logs, or
commands as literal values. URL-encode reserved characters in database
usernames or passwords.

The application has no Supabase Auth dependency. Users, bcrypt password hashes,
roles, and permissions are stored in PostgreSQL. JWTs are stateless and signed
with `JWT_SECRET`; preserve the existing secret during cutover so existing JWTs
remain valid. Preserving user IDs, `roleId`, roles, and permission rows is
necessary for existing relationships and authorization to continue working.
Prisma tracks applied migrations in `_prisma_migrations`; the public-schema
archive preserves that table. Do not run the demo seed.

Before cutover:

1. Install PostgreSQL client tools (`pg_dump`, `pg_restore`, and `psql`) with a
   version compatible with the source PostgreSQL server. Prefer a direct,
   unpooled Supabase source connection. If that endpoint is IPv6-only and the
   migration host has no IPv6 connectivity, use Supabase's **Session Pooler**
   connection (port `5432`) as `SUPABASE_SOURCE_URL`; do not use its
   Transaction Pooler (port `6543`). Use Neon's **direct/unpooled** URL for
   restore and schema operations; do not use a Neon pooler URL with `pg_dump`
   or `pg_restore`.
2. Freeze writes to the source application. Set `SUPABASE_SOURCE_URL` in the
   local shell from a secure secret store (do not paste it into a command or
   commit it). Confirm `DIRECT_URL` is the Neon direct URL and the Neon target
   database is empty. Do not run `prisma migrate deploy` on the target before
   restoring the full dump.
3. Create a full source backup outside the repository, then create a separate
   application-schema archive for the Neon import. In PowerShell:

   ```powershell
   $backupDirectory = Join-Path $env:USERPROFILE "secure-db-backups"
   New-Item -ItemType Directory -Force -Path $backupDirectory | Out-Null
   $backupFile = Join-Path $backupDirectory "executive-reminder-supabase-full-backup.dump"
   $appDumpFile = Join-Path $backupDirectory "executive-reminder-public-schema.dump"

   pg_dump --format=custom --no-owner --no-acl --file $backupFile --dbname $env:SUPABASE_SOURCE_URL
   if ($LASTEXITCODE -ne 0) { throw "Supabase backup failed; do not proceed." }

   pg_restore --list $backupFile | Out-Null
   if ($LASTEXITCODE -ne 0) { throw "Backup archive verification failed; do not proceed." }

   pg_dump --format=custom --no-owner --no-acl --schema=public --file $appDumpFile --dbname $env:SUPABASE_SOURCE_URL
   if ($LASTEXITCODE -ne 0) { throw "Application-schema export failed; do not proceed." }
   pg_restore --list $appDumpFile | Out-Null
   if ($LASTEXITCODE -ne 0) { throw "Application archive verification failed; do not proceed." }

   Get-FileHash $backupFile, $appDumpFile -Algorithm SHA256
   ```

   The full archive is for source recovery; the public-schema archive contains
   this Prisma application's tables and `_prisma_migrations` for import.
   Supabase-managed schemas are not restored to Neon. The app does not use
   Supabase Auth, and uploaded files remain in Supabase Storage under the
   selected plan. Retain both archives and checksums in access-controlled
   backup storage; keep the source until restore and application verification
   are complete.
4. With the source still read-only, save its exact table counts before
   restoring:

   ```powershell
   $sourceCounts = Join-Path $backupDirectory "supabase-row-counts.csv"
   psql --csv --no-psqlrc --set ON_ERROR_STOP=1 --dbname $env:SUPABASE_SOURCE_URL --file prisma/migration-row-counts.sql --output $sourceCounts
   if ($LASTEXITCODE -ne 0) { throw "Source row-count verification failed; do not proceed." }
   ```

   Review that every expected table is present and the counts are plausible.
   The three `CHECK:` results must all be zero: they flag normalized-email
   collisions, users whose role cannot be resolved, and mismatches between the
   user's role label and assigned role.
5. Restore the public-schema archive to the confirmed-empty Neon database
   using its direct URL. Do not use `--clean` or `--create`:

   ```powershell
   pg_restore --exit-on-error --no-owner --no-acl --dbname $env:DIRECT_URL $appDumpFile
   if ($LASTEXITCODE -ne 0) { throw "Neon restore failed; keep the source online and investigate." }
   ```

   A failed restore can leave partial objects on Neon. Do not blindly retry it
   or drop objects; keep the source untouched and inspect the target. Retry
   only against a newly confirmed-empty database.

6. Run the exact row-count query against Neon again and compare every table,
   including `User`, `Role`, `Permission`, all business/relationship tables,
   attachment metadata/legacy bytes, notification data, and
   `_prisma_migrations`. Check Prisma migration state with
   `npx prisma migrate status`. Stop and investigate any missing tables,
   count mismatch, failed migration, or restore error; do not seed, reset, or
   mark migrations applied to make the check pass. Only run
   `npm run prisma:migrate:deploy` if the restored migration history has been
   reviewed and Prisma reports pending migrations that are expected for the
   deployed code. Save and compare counts:

   ```powershell
   $neonCounts = Join-Path $backupDirectory "neon-row-counts.csv"
   psql --csv --no-psqlrc --set ON_ERROR_STOP=1 --dbname $env:DIRECT_URL --file prisma/migration-row-counts.sql --output $neonCounts
   if ($LASTEXITCODE -ne 0) { throw "Neon row-count verification failed." }
   $countDifferences = Compare-Object (Get-Content $sourceCounts) (Get-Content $neonCounts)
   if ($countDifferences) { $countDifferences; throw "Row counts differ; keep the source online." }
   ```

   Also export and compare `public` schema-only dumps to verify tables, enum
   types, indexes, and constraints match:

   ```powershell
   $sourceSchema = Join-Path $backupDirectory "supabase-public-schema.sql"
   $neonSchema = Join-Path $backupDirectory "neon-public-schema.sql"
   pg_dump --schema-only --no-owner --no-acl --schema=public --file $sourceSchema --dbname $env:SUPABASE_SOURCE_URL
   if ($LASTEXITCODE -ne 0) { throw "Could not export source schema." }
   pg_dump --schema-only --no-owner --no-acl --schema=public --file $neonSchema --dbname $env:DIRECT_URL
   if ($LASTEXITCODE -ne 0) { throw "Could not export Neon schema." }
   $schemaDifferences = Compare-Object (Get-Content $sourceSchema) (Get-Content $neonSchema)
   if ($schemaDifferences) { $schemaDifferences; throw "Schemas differ; keep the source online." }
   ```
7. Point the backend runtime `DATABASE_URL` at the Neon pooled URL, retain the
   current `JWT_SECRET`, and test login with an existing user, permissions,
   and representative task, reminder, request, meeting, and notification
   create/read/update flows. Keep the Supabase source available and read-only
   until these checks pass; then enable writes on Neon and cut over traffic.

`prisma/migration-row-counts.sql` checks row counts, not row-by-row equality or
file objects. Repeatable counts plus a readable backup do not replace a tested
restore/rollback plan. Schedule downtime for this dump/restore process; writes
made after the dump are not included. Do not decommission Supabase until the
Neon application and backups have been verified.

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
are written by the existing authenticated NestJS/Prisma backend and stored in
the configured PostgreSQL database.

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

- `DATABASE_URL`: the Neon pooled connection string for the runtime, with
  `sslmode=require`.
- `DIRECT_URL`: the Neon direct/unpooled connection string for Prisma migrations
  and schema operations, with `sslmode=require`.
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
reachable production `DATABASE_URL`; check the Vercel function logs and Neon
connectivity if those requests return 503 or 504 responses.

Copy the pooled and direct connection strings from the Neon Console. The
Supabase project URL and publishable key are not PostgreSQL connection strings.
Do not use `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` as `DATABASE_URL`. Do not
commit either database connection string or any database password.

For a new empty database, set the variables, run `npm run prisma:migrate:deploy`
with the Production `DIRECT_URL`, then redeploy so the function receives the
runtime variables and the production deployment activates its configured cron
schedule. For an existing Supabase database, follow the full backup/restore
procedure above instead; do not initialize it with the demo seed. Copy the
already-generated
VAPID key pair from secure server-side configuration; do not generate or
commit another pair. The checked-in Prisma migrations are stored in
`prisma/migrations`.
The API routes are served below `/api` (for example, `POST /api/auth/login`).

### Local frontend-to-database test

1. Copy `.env.example` to `.env` and replace its URL and JWT placeholders with
   the values from the Neon Console. Keep `.env` out of source control. Use a
   pooled URL for `DATABASE_URL` and the direct URL for `DIRECT_URL`.
2. From this backend folder, run `npm install`, `npm run prisma:generate`, and
   `npm run prisma:migrate:deploy` only against a new, empty development
   database. Do not run the destructive demo seed on a database with data.
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

The checked-in `.env.example` contains placeholders only. Keep actual Neon
connection strings and JWT secrets in the backend's ignored `.env` file or
deployment environment settings, never in frontend configuration. Supabase
environment variables remain necessary only while Supabase Storage is used for
private uploaded-file objects.
