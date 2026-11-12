-- Meeting participants get a private hidden thread so boardroom execution does not
-- inherit the bot's ordinary chat history or pollute that chat with meeting turns.
ALTER TABLE "meeting_participants" ADD COLUMN "threadId" TEXT;
