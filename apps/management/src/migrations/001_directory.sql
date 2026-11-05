-- breinhap#25: workspaces, learner profiles, groups, adult relationships, explicit capabilities and an
-- audit trail. Adults are identified by their ASafariM subject (an opaque account id); learners have no
-- account yet, only a minimal profile: a first name or nickname and the school year. No birth date,
-- e-mail, diagnosis or other child details are stored.

CREATE TABLE workspaces (
  id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{0,40}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE learners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces (id),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 40),
  -- the year of secondary school (1 to 6); Breinhap starts with the 3rd year
  school_year smallint NOT NULL CHECK (school_year BETWEEN 1 AND 6),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX learners_workspace ON learners (workspace_id) WHERE archived_at IS NULL;

CREATE TABLE groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces (id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX groups_workspace ON groups (workspace_id) WHERE archived_at IS NULL;

-- a learner in a group: both of the same workspace (checked by the trigger below)
CREATE TABLE group_learners (
  group_id uuid NOT NULL REFERENCES groups (id),
  learner_id uuid NOT NULL REFERENCES learners (id),
  added_by text NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, learner_id)
);

-- an adult's explicit relationship with one learner or one group. Granted by an administrator, never by
-- the adult themself; revoked links are kept (revoked_at) so the history stays readable.
CREATE TABLE adult_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces (id),
  adult_sub text NOT NULL CHECK (char_length(adult_sub) BETWEEN 1 AND 400),
  learner_id uuid REFERENCES learners (id),
  group_id uuid REFERENCES groups (id),
  granted_by text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_by text,
  revoked_at timestamptz,
  CHECK ((learner_id IS NULL) <> (group_id IS NULL)),
  CHECK (granted_by <> adult_sub),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE UNIQUE INDEX adult_links_one_learner ON adult_links (workspace_id, adult_sub, learner_id)
  WHERE revoked_at IS NULL AND learner_id IS NOT NULL;
CREATE UNIQUE INDEX adult_links_one_group ON adult_links (workspace_id, adult_sub, group_id)
  WHERE revoked_at IS NULL AND group_id IS NOT NULL;
CREATE INDEX adult_links_adult ON adult_links (workspace_id, adult_sub) WHERE revoked_at IS NULL;

-- review and publish are never implied by a role: an administrator grants them to a named adult
CREATE TABLE capability_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces (id),
  adult_sub text NOT NULL CHECK (char_length(adult_sub) BETWEEN 1 AND 400),
  capability text NOT NULL CHECK (capability IN ('content.review', 'content.publish')),
  granted_by text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_by text,
  revoked_at timestamptz,
  CHECK (granted_by <> adult_sub),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE UNIQUE INDEX capability_grants_active ON capability_grants (workspace_id, adult_sub, capability)
  WHERE revoked_at IS NULL;

-- minimal audit: who (hashed), what, on which kind of thing, and the outcome; never names
CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  workspace_id text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  action text NOT NULL CHECK (action ~ '^[a-z]+(\.[a-z_]+)+$'),
  target text NOT NULL,
  result text NOT NULL CHECK (result IN ('done', 'denied', 'refused'))
);
CREATE INDEX audit_events_workspace_at ON audit_events (workspace_id, at);

-- workspace consistency: a learner joins only a group of its own workspace, a link points into its own
-- workspace. Enforced here so that no code path can cross a workspace boundary.
CREATE FUNCTION same_workspace() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  g text;
  l text;
BEGIN
  IF TG_TABLE_NAME = 'group_learners' THEN
    SELECT workspace_id INTO g FROM groups WHERE id = NEW.group_id;
    SELECT workspace_id INTO l FROM learners WHERE id = NEW.learner_id;
    IF g IS DISTINCT FROM l THEN
      RAISE EXCEPTION 'group and learner belong to different workspaces' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW.learner_id IS NOT NULL THEN
      SELECT workspace_id INTO l FROM learners WHERE id = NEW.learner_id;
    ELSE
      SELECT workspace_id INTO l FROM groups WHERE id = NEW.group_id;
    END IF;
    IF l IS DISTINCT FROM NEW.workspace_id THEN
      RAISE EXCEPTION 'link target belongs to another workspace' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER group_learners_same_workspace BEFORE INSERT OR UPDATE ON group_learners
  FOR EACH ROW EXECUTE FUNCTION same_workspace();
CREATE TRIGGER adult_links_same_workspace BEFORE INSERT OR UPDATE ON adult_links
  FOR EACH ROW EXECUTE FUNCTION same_workspace();
