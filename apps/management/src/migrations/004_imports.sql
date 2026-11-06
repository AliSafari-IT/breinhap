-- breinhap#30: structured imports. An upload is first a plan (a dry run): one item per learning object
-- with what would happen (create, update, skip, or an error), shown to the importer. Nothing is written
-- to the library until they confirm. Confirming runs the planned items once each; a repeated or
-- interrupted confirm resumes where it stopped and never creates anything twice.
CREATE TABLE imports (
  workspace_id text NOT NULL REFERENCES workspaces (id),
  id uuid NOT NULL,
  importer_sub text NOT NULL CHECK (char_length(importer_sub) BETWEEN 1 AND 400),
  format text NOT NULL CHECK (format IN ('pack', 'csv')),
  file_sha256 text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'partial', 'done')),
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  finished_at timestamptz,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX imports_importer ON imports (workspace_id, importer_sub, created_at DESC);

CREATE TABLE import_items (
  workspace_id text NOT NULL,
  import_id uuid NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  object_id text NOT NULL CHECK (char_length(object_id) BETWEEN 1 AND 80),
  action text NOT NULL CHECK (action IN ('create', 'update', 'skip')),
  -- why it is skipped (identical, owned_elsewhere, archived, mission_in_use)
  reason text CHECK (reason ~ '^[a-z_]{1,40}$'),
  -- the draft version the update was planned against: a newer one means someone edited in between
  expected_version integer,
  -- the validated learning object (always a draft) for create and update
  content jsonb,
  result text NOT NULL DEFAULT 'pending' CHECK (result IN ('pending', 'done', 'conflict', 'skipped')),
  PRIMARY KEY (workspace_id, import_id, position),
  FOREIGN KEY (workspace_id, import_id) REFERENCES imports (workspace_id, id),
  CHECK ((action = 'skip') = (content IS NULL)),
  CHECK (action <> 'update' OR expected_version IS NOT NULL),
  CHECK (content IS NULL OR content -> 'review' ->> 'status' = 'draft')
);
