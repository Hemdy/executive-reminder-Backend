ALTER TABLE "Notification"
    ADD COLUMN "eventKey" TEXT,
    ADD COLUMN "pushClaimedAt" TIMESTAMP(3),
    ADD COLUMN "pushSentAt" TIMESTAMP(3),
    ADD COLUMN "pushAttempts" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "NotificationEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotificationEvent_userId_eventKey_key"
    ON "NotificationEvent"("userId", "eventKey");

CREATE INDEX "NotificationEvent_createdAt_idx"
    ON "NotificationEvent"("createdAt");

ALTER TABLE "NotificationEvent"
    ADD CONSTRAINT "NotificationEvent_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "Notification_userId_eventKey_key"
    ON "Notification"("userId", "eventKey");

CREATE INDEX "Notification_pushSentAt_pushClaimedAt_idx"
    ON "Notification"("pushSentAt", "pushClaimedAt");

CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "expirationTime" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PushSubscription_endpoint_key"
    ON "PushSubscription"("endpoint");

CREATE INDEX "PushSubscription_userId_idx"
    ON "PushSubscription"("userId");

ALTER TABLE "PushSubscription"
    ADD CONSTRAINT "PushSubscription_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "MeetingComment" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MeetingComment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MeetingComment_meetingId_createdAt_idx"
    ON "MeetingComment"("meetingId", "createdAt");

ALTER TABLE "MeetingComment"
    ADD CONSTRAINT "MeetingComment_meetingId_fkey"
    FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "MeetingComment_authorId_fkey"
    FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
