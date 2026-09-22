# Executive Reminder API

NestJS, Prisma and TypeScript backend for the Angular Executive Reminder application.

## Setup
Copy `.env.example` to `.env`, install dependencies (`npm install`), then run
`npx prisma generate`, `npx prisma migrate dev --name init`, `npm run prisma:seed` and
`npm run start:dev`. The demo account is `demo@example.com` / `ChangeMe123!`; change it
immediately in a real environment.

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
Prisma migrations are stored under `prisma/migrations` after running the migration command.
The Vercel-compatible function entry point is `api/index.ts`.
