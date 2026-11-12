-- breinhap#34: explicit assignment of an active, reviewed publication to one linked learner or one
-- linked group. A row is history: changing the availability window is recorded on the same row, and
-- revocation keeps the row (and the audit event) instead of deleting it. The learner-facing read
-- boundary is in the service; the database guarantees that an assignment can only point at an active
-- publication and at a learner/group of the same workspace.

CREATE TABLE content_assignments (
  workspace_id text NOT NULL REFERENCES workspaces (id),
  id uuid NOT NULL,
  publication_id uuid NOT NULL,
  learner_id uuid REFERENCES learners (id),
  group_id uuid REFERENCES groups (id),
  assigned_by text NOT NULL CHECK (char_length(assigned_by) BETWEEN 1 AND 400),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  not_before timestamptz NOT NULL,
  available_until timestamptz,
  revoked_at timestamptz,
  revoked_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, publication_id)
    REFERENCES content_publications (workspace_id, id),
  CHECK ((learner_id IS NULL) <> (group_id IS NULL)),
  CHECK (available_until IS NULL OR not_before < available_until),
  -- One bounded school-year window. The service applies the same limit before writing.
  CHECK (available_until IS NULL OR available_until <= assigned_at + interval '366 days'),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CHECK (revoked_at IS NULL OR revoked_at >= assigned_at)
);

-- One active assignment per publication and target. Revoked rows stay for history, so assigning
-- again later creates a new row instead of resurrecting the old one.
CREATE UNIQUE INDEX content_assignments_one_learner
  ON content_assignments (workspace_id, publication_id, learner_id)
  WHERE revoked_at IS NULL AND learner_id IS NOT NULL;
CREATE UNIQUE INDEX content_assignments_one_group
  ON content_assignments (workspace_id, publication_id, group_id)
  WHERE revoked_at IS NULL AND group_id IS NOT NULL;
CREATE INDEX content_assignments_owner
  ON content_assignments (workspace_id, assigned_by, assigned_at DESC);
CREATE INDEX content_assignments_learner
  ON content_assignments (workspace_id, learner_id) WHERE revoked_at IS NULL AND learner_id IS NOT NULL;
CREATE INDEX content_assignments_group
  ON content_assignments (workspace_id, group_id) WHERE revoked_at IS NULL AND group_id IS NOT NULL;

CREATE FUNCTION content_assignment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  publication_state text;
  learner_workspace text;
  group_workspace text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT p.state INTO publication_state
      FROM content_publications p
      JOIN learning_objects lo
        ON lo.workspace_id = p.workspace_id AND lo.id = p.learning_object_id
     WHERE p.workspace_id = NEW.workspace_id AND p.id = NEW.publication_id
       AND lo.archived_at IS NULL;
    IF publication_state IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'only an active publication can be assigned'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.learner_id IS NOT NULL THEN
      SELECT workspace_id INTO learner_workspace
        FROM learners WHERE id = NEW.learner_id AND archived_at IS NULL;
      IF learner_workspace IS DISTINCT FROM NEW.workspace_id THEN
        RAISE EXCEPTION 'the learner belongs to another workspace or is archived'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      SELECT workspace_id INTO group_workspace
        FROM groups WHERE id = NEW.group_id AND archived_at IS NULL;
      IF group_workspace IS DISTINCT FROM NEW.workspace_id THEN
        RAISE EXCEPTION 'the group belongs to another workspace or is archived'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- Identity and target never change. A revoked row is final; an active row may move its window or
  -- be revoked once, always with a new version.
  IF (NEW.workspace_id, NEW.id, NEW.publication_id, NEW.learner_id, NEW.group_id,
      NEW.assigned_by, NEW.assigned_at)
     IS DISTINCT FROM
     (OLD.workspace_id, OLD.id, OLD.publication_id, OLD.learner_id, OLD.group_id,
      OLD.assigned_by, OLD.assigned_at) THEN
    RAISE EXCEPTION 'an assignment keeps its publication, target and assigner'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'a revoked assignment is final' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'an assignment change increments its version'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'an assignment keeps its time order'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER content_assignments_guard
  BEFORE INSERT OR UPDATE ON content_assignments
  FOR EACH ROW EXECUTE FUNCTION content_assignment_guard();

CREATE FUNCTION reject_assignment_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'assignments keep their history' USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER content_assignments_immutable
  BEFORE DELETE ON content_assignments
  FOR EACH ROW EXECUTE FUNCTION reject_assignment_delete();
