-- breinhap#35: the public mission catalogue on breinhap.com. A listing makes a learning object's
-- current active publication readable without a login. It never widens what a publication is: a
-- reader still gets only the active, independently reviewed pack, so withdrawing or superseding the
-- publication changes what the public sees at once, and an object without an active publication is
-- simply absent from the catalogue. Listing and unlisting are explicit administrator actions (the
-- administrator role is an ASafariM-checked membership, not a database grant, so the service checks
-- it and audits every attempt). A row is history: unlisting stamps it, it is never deleted, and at
-- most one listing per object is current.

CREATE TABLE public_listings (
  workspace_id text NOT NULL REFERENCES workspaces (id),
  id uuid NOT NULL,
  learning_object_id text NOT NULL,
  listed_by text NOT NULL CHECK (char_length(listed_by) BETWEEN 1 AND 400),
  listed_at timestamptz NOT NULL DEFAULT now(),
  unlisted_at timestamptz,
  unlisted_by text,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, learning_object_id) REFERENCES learning_objects (workspace_id, id),
  CHECK ((unlisted_at IS NULL) = (unlisted_by IS NULL)),
  CHECK (unlisted_at IS NULL OR unlisted_at >= listed_at)
);

CREATE UNIQUE INDEX public_listings_current
  ON public_listings (workspace_id, learning_object_id) WHERE unlisted_at IS NULL;

-- A listing needs an active publication when it is made, and the only change a row allows is being
-- unlisted once, with who and when.
CREATE FUNCTION public_listing_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.unlisted_at IS NOT NULL THEN
      RAISE EXCEPTION 'a listing starts current' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM content_publications p
       WHERE p.workspace_id = NEW.workspace_id AND p.learning_object_id = NEW.learning_object_id
         AND p.state = 'active'
    ) THEN
      RAISE EXCEPTION 'only published content can be listed' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF (NEW.workspace_id, NEW.id, NEW.learning_object_id, NEW.listed_by, NEW.listed_at)
       IS DISTINCT FROM (OLD.workspace_id, OLD.id, OLD.learning_object_id, OLD.listed_by, OLD.listed_at) THEN
      RAISE EXCEPTION 'a listing keeps its identity' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.unlisted_at IS NOT NULL OR NEW.unlisted_at IS NULL OR NEW.unlisted_by IS NULL THEN
      RAISE EXCEPTION 'a listing can only be unlisted, once' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER public_listings_guard BEFORE INSERT OR UPDATE ON public_listings
  FOR EACH ROW EXECUTE FUNCTION public_listing_guard();

CREATE FUNCTION reject_public_listing_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'public listings are history' USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER public_listings_history BEFORE DELETE ON public_listings
  FOR EACH ROW EXECUTE FUNCTION reject_public_listing_delete();
