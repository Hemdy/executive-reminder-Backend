-- Keep existing comments and legacy attachment metadata while moving new uploads
-- to object storage instead of writing their bytes to PostgreSQL.
ALTER TABLE "TaskComment" RENAME COLUMN "body" TO "content";
ALTER TABLE "TaskComment"
    ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "TaskAttachment"
    ADD COLUMN "storagePath" TEXT;
ALTER TABLE "TaskAttachment"
    ALTER COLUMN "content" DROP NOT NULL;

CREATE UNIQUE INDEX "TaskAttachment_storagePath_key" ON "TaskAttachment"("storagePath");
