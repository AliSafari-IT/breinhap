-- breinhap#31: text extracted from an uploaded PDF or DOCX, as a background job. One extraction per
-- upload (so starting or retrying it twice never makes a second one); it belongs to the uploader.
-- The extracted blocks are the author's raw material: nothing here is a learning object. Drafts are
-- made only when the author saves one in the editor, and are linked back in extraction_drafts.
CREATE TABLE extractions (
  workspace_id text NOT NULL REFERENCES workspaces (id),
  id uuid NOT NULL,
  upload_id uuid NOT NULL,
  requester_sub text NOT NULL CHECK (char_length(requester_sub) BETWEEN 1 AND 400),
  kind text NOT NULL CHECK (kind IN ('pdf', 'docx')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  progress smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  -- attempts of the current run; a retry starts again at 0
  attempts smallint NOT NULL DEFAULT 0,
  cancel_requested boolean NOT NULL DEFAULT false,
  -- a short code (corrupt, encrypted, timeout, …), never a parser message or document text
  error text CHECK (error ~ '^[a-z_]{1,40}$'),
  warnings jsonb NOT NULL DEFAULT '[]',
  -- [{ type, text, ref: { page } | { paragraph } }] once done; cleared on retry, cancel and cleanup
  blocks jsonb,
  units integer,
  -- which process holds a running job, and until when; a lapsed lease is picked up by another worker
  lease_owner text,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, upload_id),
  FOREIGN KEY (workspace_id, upload_id) REFERENCES uploads (workspace_id, id),
  CHECK ((status = 'running') = (lease_owner IS NOT NULL)),
  CHECK (status = 'done' OR blocks IS NULL),
  CHECK (status <> 'failed' OR error IS NOT NULL)
);
CREATE INDEX extractions_queue ON extractions (created_at) WHERE status IN ('queued', 'running');
CREATE INDEX extractions_requester ON extractions (workspace_id, requester_sub, updated_at DESC);

-- Drafts an author saved from an extraction (the learning object stays theirs if the file goes).
CREATE TABLE extraction_drafts (
  workspace_id text NOT NULL,
  extraction_id uuid NOT NULL,
  learning_object_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, extraction_id, learning_object_id),
  FOREIGN KEY (workspace_id, extraction_id) REFERENCES extractions (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, learning_object_id) REFERENCES learning_objects (workspace_id, id)
);
