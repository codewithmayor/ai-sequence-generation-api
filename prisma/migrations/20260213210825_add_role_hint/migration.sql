-- AlterTable
ALTER TABLE "message_sequences" ADD COLUMN     "roleHint" TEXT;

-- CreateIndex
CREATE INDEX "message_sequences_prospectId_tovConfigId_companyContext_seq_idx" ON "message_sequences"("prospectId", "tovConfigId", "companyContext", "sequenceLength");
