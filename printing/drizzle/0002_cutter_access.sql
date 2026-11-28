ALTER TABLE printing_sessions RENAME TO printing_sessions_previous;
--> statement-breakpoint
CREATE TABLE printing_sessions (
  token_hash TEXT PRIMARY KEY,
  department TEXT NOT NULL CHECK (department IN ('box', 'roll', 'cutter')),
  expires_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
INSERT INTO printing_sessions SELECT * FROM printing_sessions_previous;
--> statement-breakpoint
DROP TABLE printing_sessions_previous;
--> statement-breakpoint
CREATE INDEX printing_session_expiry ON printing_sessions (expires_at);
--> statement-breakpoint
ALTER TABLE printing_login_attempts RENAME TO printing_login_attempts_previous;
--> statement-breakpoint
CREATE TABLE printing_login_attempts (
  id TEXT PRIMARY KEY,
  department TEXT NOT NULL CHECK (department IN ('box', 'roll', 'cutter')),
  client TEXT NOT NULL,
  at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
INSERT INTO printing_login_attempts SELECT * FROM printing_login_attempts_previous;
--> statement-breakpoint
DROP TABLE printing_login_attempts_previous;
--> statement-breakpoint
CREATE INDEX printing_attempts_expiry ON printing_login_attempts (department, at);
