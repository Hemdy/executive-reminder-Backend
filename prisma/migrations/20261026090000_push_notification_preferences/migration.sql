ALTER TYPE "NotificationType" ADD VALUE 'TASK_UPDATED';
ALTER TYPE "NotificationType" ADD VALUE 'TASK_STATUS';

CREATE TABLE "NotificationPreference" (
    "userId" TEXT NOT NULL,
    "tasks" BOOLEAN NOT NULL DEFAULT true,
    "reminders" BOOLEAN NOT NULL DEFAULT true,
    "requests" BOOLEAN NOT NULL DEFAULT true,
    "meetings" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "NotificationPreference"
    ADD CONSTRAINT "NotificationPreference_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
