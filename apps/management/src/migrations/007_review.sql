-- breinhap#32: the review queue. A revision is offered for review by its owner, then decided on by an
-- independently authorized reviewer. Submissions and decisions are server metadata, never content:
-- an author's review flag still cannot reach these tables, and the database refuses a decision on an
-- unsubmitted revision or by the object's own owner.

-- The draft version a revision was snapshotted from. It lets the library say whether the editable
-- draft has moved on since the latest revision (an approval then no longer describes the draft).
ALTER TABLE learning_object_revisions ADD COLUMN source_version integer CHECK (source_version >= 1);

-- The reviewer's comment belongs beside the decision, not in the content. Empty for an approval
-- without a note; required by the workflow when changes are requested.
ALTER TABLE revision_reviews ADD COLUMN comment text NOT NULL DEFAULT ''
  CHECK (char_length(comment) <= 2000);

-- One immutable submission per revision. A revision is only reviewed after its owner offered it, and
-- a decided revision is never submitted again (a new revision is recorded instead).
CREATE TABLE revision_submissions (
  workspace_id text NOT NULL,
  learning_object_id text NOT NULL,
  revision integer NOT NULL,
  submitted_by text NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, learning_object_id, revision),
  FOREIGN KEY (workspace_id, learning_object_id, revision)
    REFERENCES learning_object_revisions (workspace_id, learning_object_id, revision)
);
CREATE INDEX revision_submissions_queue ON revision_submissions (workspace_id, submitted_at, learning_object_id, revision);

CREATE TRIGGER revision_submissions_immutable BEFORE UPDATE OR DELETE ON revision_submissions
  FOR EACH ROW EXECUTE FUNCTION reject_change();

-- Only the object's owner offers its revision. The service checks this too; the database makes it
-- true for any future code path that writes a submission.
CREATE FUNCTION revision_submission_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owner text;
BEGIN
  SELECT owner_sub INTO owner FROM learning_objects
   WHERE workspace_id = NEW.workspace_id AND id = NEW.learning_object_id;
  IF owner IS NULL THEN
    RAISE EXCEPTION 'unknown learning object' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF owner <> NEW.submitted_by THEN
    RAISE EXCEPTION 'only the owner can submit a revision' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER revision_submissions_guard BEFORE INSERT ON revision_submissions
  FOR EACH ROW EXECUTE FUNCTION revision_submission_guard();

-- Review decisions stay server-side: no decision without a submission, and never on one's own
-- content. This mirrors the service checks, so a future code path cannot skip them either.
CREATE FUNCTION revision_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owner text;
BEGIN
  SELECT owner_sub INTO owner FROM learning_objects
   WHERE workspace_id = NEW.workspace_id AND id = NEW.learning_object_id;
  IF owner IS NULL THEN
    RAISE EXCEPTION 'unknown learning object' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF owner = NEW.reviewer_sub THEN
    RAISE EXCEPTION 'a reviewer cannot decide on their own content' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM revision_submissions s
     WHERE s.workspace_id = NEW.workspace_id
       AND s.learning_object_id = NEW.learning_object_id
       AND s.revision = NEW.revision
  ) THEN
    RAISE EXCEPTION 'a revision must be submitted before review' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER revision_reviews_guard BEFORE INSERT ON revision_reviews
  FOR EACH ROW EXECUTE FUNCTION revision_review_guard();
