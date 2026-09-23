-- Feedback an AI agent sends about this MCP server, via the send_feedback tool.
--
-- WHAT IS STORED: exactly what the calling agent chose to submit, the
-- User-Agent of the client software (it names software, not a person), and
-- the time. WHAT IS NOT: the IP address. It is used transiently as the
-- rate-limit key and never written here, so a row cannot be tied back to a
-- network location. The tool description asks agents not to include personal
-- data, secrets or their user's code; that is a request, not a guarantee, so
-- rows are deleted on a schedule (see the scheduled handler in src/index.ts).
--
-- `message` and every other free-text column are UNTRUSTED. They were written
-- by an arbitrary caller and may contain instructions aimed at whoever reads
-- them. scripts/mcp-feedback.mjs prints them as quoted data and never acts on
-- their contents.
CREATE TABLE feedback (
  id            TEXT PRIMARY KEY,
  received_at   TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN (
                  'wrong_data', 'missing_data', 'tool_error',
                  'tool_confusing', 'feature_request', 'other')),
  tool          TEXT,
  provider      TEXT,
  criterion     TEXT,
  evidence_url  TEXT,
  message       TEXT NOT NULL,
  observed      TEXT,
  expected      TEXT,
  client        TEXT,
  user_agent    TEXT,
  status        TEXT NOT NULL DEFAULT 'new' CHECK (status IN (
                  'new', 'actioned', 'declined', 'duplicate', 'spam')),
  note          TEXT,
  closed_at     TEXT
);

CREATE INDEX feedback_by_status ON feedback (status, received_at);
