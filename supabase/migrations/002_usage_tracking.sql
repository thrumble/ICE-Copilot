-- Add usage tracking columns to chat_messages
-- Each assistant message row carries its own tool and token usage data

ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS tool_usage jsonb;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS token_usage jsonb;

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_chat_messages_token_usage ON chat_messages(token_usage) WHERE token_usage IS NOT NULL;
-- Use GIN index for jsonb rather than btree, which fails if jsonb exceeds 2704 bytes
-- CREATE INDEX IF NOT EXISTS idx_chat_messages_tool_usage ON chat_messages USING gin (tool_usage) WHERE tool_usage IS NOT NULL;

