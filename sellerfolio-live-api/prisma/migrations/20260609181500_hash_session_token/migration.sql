-- DropIndex
DROP INDEX "sessions_session_token_key";

-- AlterTable
ALTER TABLE "sessions" DROP COLUMN "session_token",
ADD COLUMN     "session_token_hash" VARCHAR(255) NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "sessions_session_token_hash_key" ON "sessions"("session_token_hash");
