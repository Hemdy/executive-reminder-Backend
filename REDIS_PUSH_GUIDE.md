# Push Notification Architecture & Free Redis Setup Guide

This guide explains the event-driven notification pipeline, how to configure the free Upstash Redis database for Vercel, and how to verify real-time push delivery on iOS and Android.

---

## 1. Overview of the Architecture

```
[Event Trigger] (Task assigned, request updated, meeting reminder, etc.)
       │
       ▼
[PushQueueService] (Enqueues job to Redis: `push:queue:pending`)
       │
       ├────────────────────────────────────────┐
       ▼                                        ▼
[Async Worker: Immediate Dispatch]    [PushDeliveryLog: Created]
       │
       ▼
[Per-Device Deduplication Check]
(Key: `push:lock:{notificationId}:{endpoint}`)
       │
       ├──────────────────────────────┬──────────────────────────────┐
       ▼                              ▼                              ▼
[iOS APNs Delivery]          [Android FCM Delivery]       [Invalid Token Handling]
- `apns-push-type: alert`     - `urgency: high`            - 404 / 410 / VAPID mismatch
- `apns-priority: 10`         - `TTL: 86400`               - Automatically pruned from DB
- `urgency: high`             - Real-time Doze wake        - Recorded in delivery logs
- Standalone PWA tray alert
       │
       ├──────────────────────────────┬──────────────────────────────┐
       ▼                              ▼                              ▼
[Status: SENT]               [Retry with Backoff]           [Dead-Letter Queue (DLQ)]
Recorded in delivery logs    (Attempts: 5s, 30s, 120s)      (Exhausted jobs in `push:queue:dlq`)
```

### Key Improvements
1. **No Vercel Cron Delays:** Delivery is event-driven via Redis instead of waiting for a once-a-day cron.
2. **Native iOS Tray Alerts:** Sends `apns-push-type: alert` and `apns-priority: 10` so notifications appear in the iOS notification tray and lock screen.
3. **Android Doze Bypass:** Sends `urgency: high` and `TTL: 86400` so Android displays heads-up alerts immediately even in background/killed states.
4. **Idempotency & Deduplication:** Redis locks ensure multi-device users never receive duplicate alerts.
5. **Auto-Pruning:** Subscriptions returning 404/410/mismatch are cleaned up automatically.
6. **Delivery Observability:** Granular delivery status (`QUEUED`, `SENT`, `FAILED`) and HTTP responses logged to PostgreSQL.

---

## 2. Setting Up Free Redis on Upstash (2 Minutes)

Upstash offers a completely free serverless Redis database (up to 10,000 commands/day, no credit card required) that connects over HTTP REST. This is ideal for Vercel Serverless because it does not maintain open TCP sockets.

### Step 1: Create the Upstash Database
1. Go to [https://console.upstash.com/](https://console.upstash.com/) and sign up for a free account.
2. Click **Create Database**.
3. Choose:
   - **Name:** `executive-reminder-redis`
   - **Type:** Regional
   - **Region:** Choose a region close to your Supabase/Vercel deployment (e.g. Frankfurt / `eu-central-1`).
   - **Plan:** Free
4. Click **Create**.

### Step 2: Copy the REST Credentials
1. In the database details page, scroll down to the **REST API** section.
2. Click the **`.env`** tab.
3. Copy the two values:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

### Step 3: Add to Vercel Environment Variables
1. Go to your **Vercel Dashboard** &rarr; `executive-reminder-backend` &rarr; **Settings** &rarr; **Environment Variables**.
2. Add:
   - `UPSTASH_REDIS_REST_URL`: `<paste value>`
   - `UPSTASH_REDIS_REST_TOKEN`: `<paste value>`
   - `CRON_SECRET`: `executive-reminder-cron-secret-2026` (or any random string)
3. Redeploy or trigger a deployment so the variables take effect.

*(For local development, you can paste these same values into `executive-reminder-Backend/.env`).*

> **Note:** If neither Upstash nor Redis is configured, the system automatically falls back to an in-memory queue so local testing never crashes.

---

## 3. Scheduled Reminders & Due Meeting Checks (Without Vercel Cron)

Because Vercel's free plan restricts crons to once daily, scheduled reminders (e.g., a reminder due at 2:30 PM) use a dual mechanism:

### 1. Zero-Cost Self-Healing Check
Whenever any user accesses the app or an API call occurs, `NotificationsService` opportunistically checks for due reminders and meetings (throttled to at most once per 60 seconds). Active users automatically trigger pending notifications.

### 2. (Recommended) Free 1-Minute External Ping
To guarantee reminders trigger to the exact minute even when nobody is currently clicking in the app, set up a free external ping:

1. Go to [https://cron-job.org/](https://cron-job.org/) (100% free forever) or [https://upstash.com/docs/qstash/](https://upstash.com/docs/qstash/).
2. Create a new cron job:
   - **URL:** `https://executive-reminder-backend.vercel.app/api/notifications/push/check-due`
   - **Schedule:** Every 1 minute (or every 5 minutes)
   - **HTTP Headers:**
     ```
     Authorization: Bearer executive-reminder-cron-secret-2026
     ```
3. Save. That's it!

---

## 4. Delivery Status & Observability Endpoints

All delivery outcomes are recorded in the `PushDeliveryLog` database table. You can inspect them using the following authenticated endpoints:

| Endpoint | Method | Description |
|---|---|---|
| `/api/notifications/push/logs` | `GET` | View recent delivery logs with status (`QUEUED`, `SENT`, `FAILED`), device type, and HTTP response. |
| `/api/notifications/push/queue/stats` | `GET` | Returns queue counts (`pending`, `retry`, `dlq`) and active provider (`upstash`, `redis`, `memory`). |
| `/api/notifications/push/queue/dlq` | `GET` | Inspect dead-letter queue jobs that failed after 3 attempts. |
| `/api/notifications/push/queue/process` | `POST` | Manually triggers the worker to process up to 25 pending jobs immediately. |
| `/api/notifications/push/check-due` | `POST`/`GET` | Checks due reminders & meetings and processes the queue (requires `Authorization: Bearer <CRON_SECRET>`). |

---

## 5. End-to-End Verification on Real Devices

### Testing on iOS (iPhone / iPad, iOS 16.4+)
1. Open Safari and navigate to `https://executive-reminder-frontend.vercel.app`.
2. Notice the **iOS Setup Banner** in the Notifications page:
   - Tap Safari's **Share** button (`⎋`).
   - Select **Add to Home Screen**.
   - Tap **Add**.
3. Launch the app from your **Home Screen**.
4. Log in and navigate to **Notifications**.
5. Tap **Enable device notifications** &rarr; tap **Allow** on the native iOS permission dialog.
6. Verify across states:
   - **Foreground:** App open &rarr; trigger an action from another tab/user (e.g. assign a task) &rarr; notification arrives.
   - **Background:** Minimize app to home screen &rarr; trigger notification &rarr; alert banner appears in native iOS tray with sound/haptic.
   - **Killed:** Swipe app away in app switcher &rarr; trigger notification &rarr; alert banner appears on lock screen and notification tray.

### Testing on Android (Chrome)
1. Open Chrome and navigate to `https://executive-reminder-frontend.vercel.app`.
2. Log in and navigate to **Notifications**.
3. Tap **Enable device notifications** &rarr; tap **Allow**.
4. Verify across states:
   - **Foreground:** App active &rarr; banner shows heads-up notification.
   - **Background:** App minimized &rarr; heads-up notification appears in system tray.
   - **Killed (Doze mode):** Swipe app away, lock the phone for 5 minutes &rarr; trigger notification &rarr; device screen lights up with high-priority FCM notification.

