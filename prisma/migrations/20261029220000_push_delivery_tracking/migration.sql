-- CreateEnum
CREATE TYPE "PushDeliveryStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "PushDeliveryLog" (
    "id" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "deviceType" TEXT,
    "status" "PushDeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "httpStatus" INTEGER,
    "errorDetails" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushDeliveryLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PushDeliveryLog_notificationId_idx" ON "PushDeliveryLog"("notificationId");

-- CreateIndex
CREATE INDEX "PushDeliveryLog_userId_idx" ON "PushDeliveryLog"("userId");

-- CreateIndex
CREATE INDEX "PushDeliveryLog_status_idx" ON "PushDeliveryLog"("status");

-- CreateIndex
CREATE INDEX "PushDeliveryLog_createdAt_idx" ON "PushDeliveryLog"("createdAt");

-- AddForeignKey
ALTER TABLE "PushDeliveryLog" ADD CONSTRAINT "PushDeliveryLog_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

