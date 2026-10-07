-- Fix B-tree index on tool_usage
-- PostgreSQL B-tree indexes cannot index values exceeding 2,704 bytes (1/3 of a buffer page).
-- When tools return multiple records, the serialized tool_usage JSON exceeds this limit,
-- causing PostgreSQL error 54000 ("index row size exceeds btree maximum") and preventing
-- messages from being inserted into the database.
DROP INDEX IF EXISTS idx_chat_messages_tool_usage;

-- If query performance on tool_usage is needed, use a GIN index instead of B-tree:
-- CREATE INDEX IF NOT EXISTS idx_chat_messages_tool_usage ON chat_messages USING gin (tool_usage);
