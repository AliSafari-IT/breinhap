-- breinhap#36: a student's own progress on assigned homework, on the server, so pausing and resuming
-- works across reloads, tabs and devices. One row per learner, assignment and mission. The row holds
-- only what the player needs to continue: the publication it was made on (its pack hash), the page,
-- the typed answers in the player's compact encoding, the state and its dates. Answers are read only
-- through the student's own session; no adult route reads this table (breinhap#137 will read only
-- state and the two dates).
--
-- Unlike the history tables, rows ARE deleted: at once when the student clears them, unlinks, or the
-- learner profile is archived, and 90 days after the assignment's window closes, the assignment is
-- revoked or its publication is replaced or withdrawn (owner decision 2026-11-15, the hourly sweep).

CREATE TABLE assignment_progress (
  workspace_id text NOT NULL REFERENCES workspaces (id),
  assignment_id uuid NOT NULL,
  learner_id uuid NOT NULL REFERENCES learners (id),
  mission_id text NOT NULL CHECK (char_length(mission_id) BETWEEN 1 AND 200),
  publication_hash text NOT NULL CHECK (publication_hash ~ '^[A-Za-z0-9_-]{43}$'),
  page integer NOT NULL CHECK (page BETWEEN 0 AND 999),
  -- the player's encoding ("0c1;3o2.0.1"): page index, then a choice or an order of item indexes
  answers text NOT NULL DEFAULT '' CHECK (char_length(answers) <= 2000 AND answers ~ '^[0-9co.;]*$'),
  state text NOT NULL CHECK (state IN ('started', 'finished')),
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (workspace_id, assignment_id, learner_id, mission_id),
  FOREIGN KEY (workspace_id, assignment_id) REFERENCES content_assignments (workspace_id, id),
  CHECK ((state = 'finished') = (finished_at IS NOT NULL)),
  CHECK (finished_at IS NULL OR finished_at >= started_at),
  CHECK (updated_at >= started_at)
);
CREATE INDEX assignment_progress_learner ON assignment_progress (workspace_id, learner_id);

CREATE FUNCTION assignment_progress_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  learner_workspace text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT workspace_id INTO learner_workspace
      FROM learners WHERE id = NEW.learner_id AND archived_at IS NULL;
    IF learner_workspace IS DISTINCT FROM NEW.workspace_id THEN
      RAISE EXCEPTION 'the learner belongs to another workspace or is archived'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- a row keeps its owner; every change is a new version, so two tabs cannot overwrite each other
  IF (NEW.workspace_id, NEW.assignment_id, NEW.learner_id, NEW.mission_id)
     IS DISTINCT FROM (OLD.workspace_id, OLD.assignment_id, OLD.learner_id, OLD.mission_id) THEN
    RAISE EXCEPTION 'progress keeps its learner, assignment and mission'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'a progress change increments its version' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER assignment_progress_guard
  BEFORE INSERT OR UPDATE ON assignment_progress
  FOR EACH ROW EXECUTE FUNCTION assignment_progress_guard();
