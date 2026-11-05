-- breinhap#26: learning objects with stable ids, one mutable draft each, immutable revisions, server-only
-- review metadata, and where the material came from. Content is the shared LearningObject schema
-- (packages/content), validated by the service before it is stored; the database guards ownership,
-- uniqueness, immutability and the workspace boundary.

-- One learning object: its stable id (the kebab-case id of the schema) is unique per workspace and never
-- changes. The owner is the adult who created it; the subject, year and title are copied from the
-- current draft for listing and filtering.
CREATE TABLE learning_objects (
  workspace_id text NOT NULL REFERENCES workspaces (id),
  id text NOT NULL CHECK (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(id) <= 80),
  owner_sub text NOT NULL CHECK (char_length(owner_sub) BETWEEN 1 AND 400),
  subject text NOT NULL,
  grade smallint NOT NULL CHECK (grade BETWEEN 1 AND 6),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX learning_objects_owner ON learning_objects (workspace_id, owner_sub) WHERE archived_at IS NULL;

-- The mutable draft: the whole LearningObject as JSON (its review is always "draft": imported review
-- flags are never trusted), the schema version it was validated against, and a version for optimistic
-- concurrency (every save names the version it edited).
CREATE TABLE learning_object_drafts (
  workspace_id text NOT NULL,
  learning_object_id text NOT NULL,
  schema_version smallint NOT NULL CHECK (schema_version >= 1),
  content jsonb NOT NULL,
  sources jsonb NOT NULL DEFAULT '[]',
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, learning_object_id),
  FOREIGN KEY (workspace_id, learning_object_id) REFERENCES learning_objects (workspace_id, id),
  CHECK (content ->> 'id' = learning_object_id),
  CHECK (content -> 'review' ->> 'status' = 'draft'),
  CHECK (jsonb_typeof(sources) = 'array')
);

-- Mission ids are stable too and unique per workspace, so any set of learning objects can form one
-- content pack (the pack schema refuses duplicate mission ids). Kept in step with each draft.
CREATE TABLE learning_object_missions (
  workspace_id text NOT NULL,
  mission_id text NOT NULL CHECK (mission_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  learning_object_id text NOT NULL,
  PRIMARY KEY (workspace_id, mission_id),
  FOREIGN KEY (workspace_id, learning_object_id) REFERENCES learning_objects (workspace_id, id)
);

-- An immutable snapshot of a draft, numbered per learning object (1, 2, …). Never updated or deleted.
CREATE TABLE learning_object_revisions (
  workspace_id text NOT NULL,
  learning_object_id text NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  schema_version smallint NOT NULL CHECK (schema_version >= 1),
  content jsonb NOT NULL,
  sources jsonb NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[A-Za-z0-9_-]{43}$'),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, learning_object_id, revision),
  FOREIGN KEY (workspace_id, learning_object_id) REFERENCES learning_objects (workspace_id, id),
  CHECK (content ->> 'id' = learning_object_id),
  CHECK (content -> 'review' ->> 'status' = 'draft')
);

-- Review metadata belongs to the server, not to the content: written only by the review workflow
-- (breinhap#32), one decision per revision, never by an author's save.
CREATE TABLE revision_reviews (
  workspace_id text NOT NULL,
  learning_object_id text NOT NULL,
  revision integer NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved', 'changes_requested')),
  reviewer_sub text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, learning_object_id, revision),
  FOREIGN KEY (workspace_id, learning_object_id, revision)
    REFERENCES learning_object_revisions (workspace_id, learning_object_id, revision)
);

CREATE FUNCTION reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: revisions are immutable', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER learning_object_revisions_immutable BEFORE UPDATE OR DELETE ON learning_object_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER revision_reviews_immutable BEFORE UPDATE OR DELETE ON revision_reviews
  FOR EACH ROW EXECUTE FUNCTION reject_change();

-- the stable id never changes, nor its workspace or owner
CREATE FUNCTION learning_object_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.workspace_id, NEW.id, NEW.owner_sub, NEW.created_at)
     IS DISTINCT FROM (OLD.workspace_id, OLD.id, OLD.owner_sub, OLD.created_at) THEN
    RAISE EXCEPTION 'a learning object keeps its id, workspace, owner and creation time'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER learning_objects_guard BEFORE UPDATE ON learning_objects
  FOR EACH ROW EXECUTE FUNCTION learning_object_guard();

-- the audit trail now also records content actions
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_action_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_check
  CHECK (action ~ '^[a-z_]+(\.[a-z_]+)+$');
