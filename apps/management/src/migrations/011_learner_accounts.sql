-- breinhap#134: the one-to-one link between a learner profile and a student's ASafariM account, made
-- with a one-time link code an adult hands to the student. The profile has no account of its own; the
-- link lets the future student service (breinhap#135/#136) resolve a verified learner id. Only the
-- ASafariM subject is stored here — never an e-mail address, which stays in ASafariM identity.
--
-- Both tables keep their history: unlinking a learner marks the row (unlinked_at) instead of erasing
-- it, and a used or revoked code keeps its row. At most one account link and at most one waiting code
-- per learner are active at any time (partial unique indexes below); a new code revokes the previous
-- one. The code itself never reaches the database: only its SHA-256 hash, so a database read cannot
-- reveal a usable code.

CREATE TABLE learner_accounts (
  workspace_id text NOT NULL REFERENCES workspaces (id),
  id uuid NOT NULL,
  learner_id uuid NOT NULL REFERENCES learners (id),
  account_sub text NOT NULL CHECK (char_length(account_sub) BETWEEN 1 AND 400),
  linked_at timestamptz NOT NULL DEFAULT now(),
  -- how the link came about; today always by redeeming a link code
  linked_by_code boolean NOT NULL DEFAULT true,
  unlinked_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  CHECK (unlinked_at IS NULL OR unlinked_at >= linked_at)
);

-- one active link per learner profile and per account subject, in this workspace
CREATE UNIQUE INDEX learner_accounts_one_learner
  ON learner_accounts (workspace_id, learner_id) WHERE unlinked_at IS NULL;
CREATE UNIQUE INDEX learner_accounts_one_account
  ON learner_accounts (workspace_id, account_sub) WHERE unlinked_at IS NULL;
CREATE INDEX learner_accounts_account ON learner_accounts (workspace_id, account_sub);

CREATE TABLE learner_link_codes (
  workspace_id text NOT NULL REFERENCES workspaces (id),
  id uuid NOT NULL,
  learner_id uuid NOT NULL REFERENCES learners (id),
  code_hash bytea NOT NULL CHECK (octet_length(code_hash) = 32),
  created_by text NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 400),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- the service grants exactly 14 days; the database repeats the bound
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  used_by text CHECK (char_length(used_by) <= 400),
  revoked_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  CHECK (expires_at > created_at),
  CHECK ((used_at IS NULL) = (used_by IS NULL)),
  CHECK (used_at IS NULL OR used_at <= expires_at),
  -- a used code is final; revocation only ends a code nobody has redeemed yet
  CHECK (used_at IS NULL OR revoked_at IS NULL)
);

-- one waiting code per learner: the service revokes the previous one when it creates a new code
CREATE UNIQUE INDEX learner_link_codes_one_waiting
  ON learner_link_codes (workspace_id, learner_id)
  WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE INDEX learner_link_codes_learner ON learner_link_codes (workspace_id, learner_id);

CREATE FUNCTION learner_account_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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

  -- the link's identity never changes; an unlinked row is final (unlink keeps the history row)
  IF (NEW.workspace_id, NEW.id, NEW.learner_id, NEW.account_sub, NEW.linked_at, NEW.linked_by_code)
     IS DISTINCT FROM
     (OLD.workspace_id, OLD.id, OLD.learner_id, OLD.account_sub, OLD.linked_at, OLD.linked_by_code) THEN
    RAISE EXCEPTION 'a learner account keeps its learner, subject and link time'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.unlinked_at IS NOT NULL THEN
    RAISE EXCEPTION 'an unlinked learner account is final' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER learner_accounts_guard
  BEFORE INSERT OR UPDATE ON learner_accounts
  FOR EACH ROW EXECUTE FUNCTION learner_account_guard();

CREATE FUNCTION learner_link_code_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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

  -- a code keeps its learner, hash, creator and validity; a used or revoked code is final
  IF (NEW.workspace_id, NEW.id, NEW.learner_id, NEW.code_hash, NEW.created_by, NEW.created_at,
      NEW.expires_at)
     IS DISTINCT FROM
     (OLD.workspace_id, OLD.id, OLD.learner_id, OLD.code_hash, OLD.created_by, OLD.created_at,
      OLD.expires_at) THEN
    RAISE EXCEPTION 'a link code keeps its learner, hash and validity'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.used_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'a used or revoked link code is final' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER learner_link_codes_guard
  BEFORE INSERT OR UPDATE ON learner_link_codes
  FOR EACH ROW EXECUTE FUNCTION learner_link_code_guard();

CREATE FUNCTION reject_learner_account_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'learner account links keep their history'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER learner_accounts_immutable
  BEFORE DELETE ON learner_accounts
  FOR EACH ROW EXECUTE FUNCTION reject_learner_account_delete();

CREATE FUNCTION reject_learner_link_code_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'link codes keep their history' USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER learner_link_codes_immutable
  BEFORE DELETE ON learner_link_codes
  FOR EACH ROW EXECUTE FUNCTION reject_learner_link_code_delete();
