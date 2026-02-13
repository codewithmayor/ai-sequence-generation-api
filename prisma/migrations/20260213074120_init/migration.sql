-- CreateTable
CREATE TABLE "prospects" (
    "id" TEXT NOT NULL,
    "linkedinUrl" TEXT NOT NULL,
    "fullName" TEXT,
    "headline" TEXT,
    "company" TEXT,
    "profileData" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prospects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tov_configs" (
    "id" TEXT NOT NULL,
    "formality" DOUBLE PRECISION NOT NULL,
    "warmth" DOUBLE PRECISION NOT NULL,
    "directness" DOUBLE PRECISION NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tov_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_sequences" (
    "id" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "tovConfigId" TEXT NOT NULL,
    "companyContext" TEXT NOT NULL,
    "sequenceLength" INTEGER NOT NULL,
    "messages" JSONB NOT NULL,
    "analysis" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_generations" (
    "id" TEXT NOT NULL,
    "sequenceId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "promptTokens" INTEGER NOT NULL,
    "completionTokens" INTEGER NOT NULL,
    "totalTokens" INTEGER NOT NULL,
    "estimatedCost" DOUBLE PRECISION NOT NULL,
    "rawResponse" JSONB NOT NULL,
    "thinking" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_generations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "prospects_linkedinUrl_key" ON "prospects"("linkedinUrl");

-- CreateIndex
CREATE INDEX "prospects_linkedinUrl_idx" ON "prospects"("linkedinUrl");

-- AddForeignKey
ALTER TABLE "message_sequences" ADD CONSTRAINT "message_sequences_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "prospects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_sequences" ADD CONSTRAINT "message_sequences_tovConfigId_fkey" FOREIGN KEY ("tovConfigId") REFERENCES "tov_configs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_generations" ADD CONSTRAINT "ai_generations_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "message_sequences"("id") ON DELETE CASCADE ON UPDATE CASCADE;
