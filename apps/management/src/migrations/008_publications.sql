-- breinhap#33: immutable, reviewed content publications. A publication is one versioned pack built
-- from one independently approved immutable revision. It is the only authority a student-facing
-- reader may use; an author's draft, an unapproved revision or a submitted review flag is never
-- enough. Lifecycle changes (superseded, withdrawn) are recorded on the same row and can happen only
-- once; restoring an older release publishes that revision again as a new row and supersedes the
-- current one atomically.

CREATE TABLE content_publications (
  workspace_id text NOT NULL REFERENCES workspaces (id),
  id uuid NOT NULL,
  learning_object_id text NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  revision_hash text NOT NULL CHECK (revision_hash ~ '^[A-Za-z0-9_-]{43}$'),
  schema_version smallint NOT NULL CHECK (schema_version = 1),
  -- The clean delivery projection: schema-valid, versioned and free of sources, review metadata,
  -- uploader details and any internal identifier.
  pack jsonb NOT NULL CHECK (jsonb_typeof(pack) = 'object'),
  pack_version integer NOT NULL CHECK (pack_version >= 1),
  pack_hash text NOT NULL CHECK (pack_hash ~ '^[A-Za-z0-9_-]{43}$'),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'superseded', 'withdrawn')),
  published_by text NOT NULL CHECK (char_length(published_by) BETWEEN 1 AND 400),
  published_at timestamptz NOT NULL DEFAULT now(),
  state_changed_at timestamptz,
  state_changed_by text,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, learning_object_id, pack_version),
  FOREIGN KEY (workspace_id, learning_object_id, revision)
    REFERENCES learning_object_revisions (workspace_id, learning_object_id, revision),
  CHECK (pack ->> 'schemaVersion' = '1'),
  CHECK (pack ->> 'id' = learning_object_id),
  CHECK ((pack ->> 'version')::integer = pack_version),
  CHECK (jsonb_typeof(pack -> 'objects') = 'array' AND jsonb_array_length(pack -> 'objects') = 1),
  CHECK (pack -> 'objects' -> 0 ->> 'id' = learning_object_id),
  CHECK (NOT (pack -> 'objects' -> 0 ? 'review')),
  CHECK (NOT (pack -> 'objects' -> 0 ? 'sources')),
  CHECK ((state = 'active') = (state_changed_at IS NULL)),
  CHECK ((state_changed_at IS NULL) = (state_changed_by IS NULL))
);

-- One current release per object. History rows stay for rollback and audit.
CREATE UNIQUE INDEX content_publications_current
  ON content_publications (workspace_id, learning_object_id) WHERE state = 'active';
CREATE INDEX content_publications_history
  ON content_publications (workspace_id, learning_object_id, published_at DESC);

-- Only a revision that an independent reviewer approved can become a publication, and only an adult
-- with an active explicit content.publish grant can create or retire one. The service checks this
-- too; the database makes it true for any future code path that writes a publication.
CREATE FUNCTION content_publication_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owner text;
  revision_hash text;
  revision_schema smallint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'active' THEN
      RAISE EXCEPTION 'a publication starts active' USING ERRCODE = 'check_violation';
    END IF;
    SELECT lo.owner_sub, r.content_hash, r.schema_version
      INTO owner, revision_hash, revision_schema
      FROM learning_objects lo
      JOIN learning_object_revisions r
        ON r.workspace_id = lo.workspace_id AND r.learning_object_id = lo.id
     WHERE lo.workspace_id = NEW.workspace_id AND lo.id = NEW.learning_object_id
       AND lo.archived_at IS NULL AND r.revision = NEW.revision;
    IF owner IS NULL THEN
      RAISE EXCEPTION 'unknown or archived learning object' USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF NEW.revision_hash IS DISTINCT FROM revision_hash
       OR NEW.schema_version IS DISTINCT FROM revision_schema THEN
      RAISE EXCEPTION 'the publication does not match its revision' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM revision_reviews v
       WHERE v.workspace_id = NEW.workspace_id
         AND v.learning_object_id = NEW.learning_object_id
         AND v.revision = NEW.revision
         AND v.decision = 'approved'
         AND v.reviewer_sub <> owner
    ) THEN
      RAISE EXCEPTION 'only an independently approved revision can be published'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM capability_grants g
       WHERE g.workspace_id = NEW.workspace_id
         AND g.adult_sub = NEW.published_by
         AND g.capability = 'content.publish'
         AND g.revoked_at IS NULL
    ) THEN
      RAISE EXCEPTION 'only an explicitly authorized publisher can publish'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- The pack, its hashes, its revision and its publisher never change. Only one transition out of
  -- active is allowed: to superseded (a newer release) or withdrawn.
  IF (NEW.workspace_id, NEW.id, NEW.learning_object_id, NEW.revision, NEW.revision_hash,
      NEW.schema_version, NEW.pack, NEW.pack_version, NEW.pack_hash, NEW.published_by,
      NEW.published_at)
     IS DISTINCT FROM
     (OLD.workspace_id, OLD.id, OLD.learning_object_id, OLD.revision, OLD.revision_hash,
      OLD.schema_version, OLD.pack, OLD.pack_version, OLD.pack_hash, OLD.published_by,
      OLD.published_at) THEN
    RAISE EXCEPTION 'a publication keeps its content and identity'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state <> 'active' THEN
    RAISE EXCEPTION 'a publication can leave active only once' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state NOT IN ('superseded', 'withdrawn') THEN
    RAISE EXCEPTION 'a publication can only become superseded or withdrawn'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state_changed_at IS NULL OR NEW.state_changed_by IS NULL THEN
    RAISE EXCEPTION 'a lifecycle change records who and when' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM capability_grants g
     WHERE g.workspace_id = NEW.workspace_id
       AND g.adult_sub = NEW.state_changed_by
       AND g.capability = 'content.publish'
       AND g.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'only an explicitly authorized publisher can retire a publication'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER content_publications_guard BEFORE INSERT OR UPDATE ON content_publications
  FOR EACH ROW EXECUTE FUNCTION content_publication_guard();

CREATE FUNCTION reject_publication_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'publications are immutable' USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER content_publications_immutable BEFORE DELETE ON content_publications
  FOR EACH ROW EXECUTE FUNCTION reject_publication_delete();
