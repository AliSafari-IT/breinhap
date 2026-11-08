-- breinhap#79: besloten opslag; geen publieke routes of vervangende publicatieworkflow.
CREATE TABLE practice_packs (
 workspace_id text NOT NULL REFERENCES workspaces(id), id uuid NOT NULL,
 owner_sub text NOT NULL, draft jsonb NOT NULL CHECK(jsonb_typeof(draft)='object'), draft_version integer NOT NULL DEFAULT 1 CHECK(draft_version>0),
 created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, archived_at timestamptz,
 PRIMARY KEY(workspace_id,id)
);
CREATE TABLE practice_pack_versions (
 workspace_id text NOT NULL, pack_id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
 model_version integer NOT NULL CHECK(model_version=1), content_schema_version integer NOT NULL CHECK(content_schema_version=1),
 envelope jsonb NOT NULL, content_hash text NOT NULL CHECK(content_hash ~ '^[A-Za-z0-9_-]{43}$'),
 created_by text NOT NULL, created_at timestamptz NOT NULL,
 PRIMARY KEY(workspace_id,pack_id,version), FOREIGN KEY(workspace_id,pack_id) REFERENCES practice_packs(workspace_id,id),
 CHECK((envelope->>'packId'=pack_id::text AND (envelope->>'version')::integer=version AND envelope->>'workspaceId'=workspace_id AND (envelope->>'modelVersion')::integer=model_version AND (envelope->>'contentSchemaVersion')::integer=content_schema_version) IS TRUE)
);
CREATE TABLE practice_pack_sources (
 workspace_id text NOT NULL, pack_id uuid NOT NULL, version integer NOT NULL, object_id text NOT NULL, revision integer NOT NULL,
 revision_hash text NOT NULL CHECK(revision_hash ~ '^[A-Za-z0-9_-]{43}$'), publication_id text NOT NULL CHECK(char_length(publication_id) BETWEEN 1 AND 120), publication_hash text NOT NULL CHECK(publication_hash ~ '^[A-Za-z0-9_-]{43}$'),
 mission_refs jsonb NOT NULL CHECK(jsonb_typeof(mission_refs)='array'), assessment_refs jsonb NOT NULL CHECK(jsonb_typeof(assessment_refs)='array'),
 PRIMARY KEY(workspace_id,pack_id,version,object_id,revision), UNIQUE(workspace_id,pack_id,version,object_id),
 FOREIGN KEY(workspace_id,pack_id,version) REFERENCES practice_pack_versions(workspace_id,pack_id,version) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,object_id,revision) REFERENCES learning_object_revisions(workspace_id,learning_object_id,revision)
);
CREATE TABLE practice_share_links (
 workspace_id text NOT NULL, id uuid NOT NULL, pack_id uuid NOT NULL, pack_version integer NOT NULL,
 token_hash bytea NOT NULL UNIQUE CHECK(octet_length(token_hash)=32), owner_membership_version text NOT NULL,
 not_before timestamptz NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz,
 max_attempts integer NOT NULL DEFAULT 1 CHECK(max_attempts=1), attempts_started integer NOT NULL DEFAULT 0 CHECK(attempts_started BETWEEN 0 AND 1),
 active_slot boolean NOT NULL DEFAULT true, created_by text NOT NULL, created_at timestamptz NOT NULL, last_used_at timestamptz,
 last_mint_nonce_hash bytea NOT NULL CHECK(octet_length(last_mint_nonce_hash)=32),
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,id,pack_id,pack_version),
 FOREIGN KEY(workspace_id,pack_id,pack_version) REFERENCES practice_pack_versions(workspace_id,pack_id,version),
 CHECK(not_before>=created_at AND not_before<expires_at AND expires_at<=created_at+interval '720 hours'), CHECK(revoked_at IS NULL OR NOT active_slot)
);
CREATE UNIQUE INDEX practice_link_active ON practice_share_links(workspace_id,pack_id) WHERE active_slot;
CREATE TABLE practice_attempts (
 workspace_id text NOT NULL, id uuid NOT NULL, link_id uuid NOT NULL, pack_id uuid NOT NULL, pack_version integer NOT NULL,
 resume_hash bytea UNIQUE CHECK(resume_hash IS NULL OR octet_length(resume_hash)=32), state text NOT NULL CHECK(state IN ('active','submitted','closed')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), current_page_key text NOT NULL,
 started_at timestamptz NOT NULL, completed_at timestamptz, last_active_at timestamptz NOT NULL, delete_after timestamptz NOT NULL, closed_at timestamptz,
 server_score integer, question_count integer NOT NULL CHECK(question_count BETWEEN 1 AND 27),
 last_nonce_hash bytea, last_payload_hash bytea, last_action text, last_outcome_version integer,
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,link_id), UNIQUE(workspace_id,id,link_id),
 FOREIGN KEY(workspace_id,link_id,pack_id,pack_version) REFERENCES practice_share_links(workspace_id,id,pack_id,pack_version),
 CHECK(delete_after=started_at+interval '720 hours'),
 CHECK((completed_at IS NULL)=(server_score IS NULL)), CHECK(server_score BETWEEN 0 AND question_count),
 CHECK(state<>'submitted' OR completed_at IS NOT NULL), CHECK(state<>'active' OR completed_at IS NULL), CHECK((state='closed')=(closed_at IS NOT NULL)),
 CHECK(last_nonce_hash IS NULL OR octet_length(last_nonce_hash)=32), CHECK(last_payload_hash IS NULL OR octet_length(last_payload_hash)=32)
);
CREATE INDEX practice_attempt_retention ON practice_attempts(delete_after);
CREATE TABLE practice_link_sessions (
 session_hash bytea PRIMARY KEY CHECK(octet_length(session_hash)=32), workspace_id text NOT NULL REFERENCES workspaces(id),
 link_id uuid, csrf_hash bytea NOT NULL CHECK(octet_length(csrf_hash)=32), state text NOT NULL CHECK(state IN ('unresolved','resolved','consumed')),
 created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, consumed_attempt_id uuid, start_nonce_hash bytea,
 FOREIGN KEY(workspace_id,link_id) REFERENCES practice_share_links(workspace_id,id),
 FOREIGN KEY(workspace_id,consumed_attempt_id,link_id) REFERENCES practice_attempts(workspace_id,id,link_id),
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '5 minutes'),
 CHECK((state='unresolved' AND link_id IS NULL AND consumed_attempt_id IS NULL AND start_nonce_hash IS NULL)
 OR (state='resolved' AND link_id IS NOT NULL AND consumed_attempt_id IS NULL AND start_nonce_hash IS NULL)
 OR (state='consumed' AND link_id IS NOT NULL AND consumed_attempt_id IS NOT NULL AND octet_length(start_nonce_hash)=32))
);
CREATE TABLE practice_answers (
 workspace_id text NOT NULL, attempt_id uuid NOT NULL, page_key text NOT NULL, answer jsonb NOT NULL,
 finalized boolean NOT NULL, server_correct boolean, saved_at timestamptz NOT NULL,
 last_nonce_hash bytea NOT NULL CHECK(octet_length(last_nonce_hash)=32), last_payload_hash bytea NOT NULL CHECK(octet_length(last_payload_hash)=32),
 PRIMARY KEY(workspace_id,attempt_id,page_key),
 FOREIGN KEY(workspace_id,attempt_id) REFERENCES practice_attempts(workspace_id,id) ON DELETE CASCADE,
 CHECK(finalized=(server_correct IS NOT NULL))
);
CREATE FUNCTION practice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='practice_packs' THEN
  IF (OLD.workspace_id,OLD.id,OLD.owner_sub,OLD.created_at) IS DISTINCT FROM (NEW.workspace_id,NEW.id,NEW.owner_sub,NEW.created_at) THEN
   RAISE EXCEPTION 'practice identity immutable' USING ERRCODE='check_violation';
  END IF;
 ELSIF TG_TABLE_NAME='practice_pack_versions' OR TG_TABLE_NAME='practice_pack_sources' THEN
  IF TG_OP='DELETE' AND TG_TABLE_NAME='practice_pack_versions' THEN
   IF EXISTS(SELECT 1 FROM practice_packs WHERE workspace_id=OLD.workspace_id AND id=OLD.pack_id AND archived_at IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM practice_share_links WHERE workspace_id=OLD.workspace_id AND pack_id=OLD.pack_id AND pack_version=OLD.version) THEN RETURN OLD; END IF;
  ELSIF TG_OP='DELETE' AND pg_trigger_depth()>1 THEN RETURN OLD;
  END IF;
  RAISE EXCEPTION 'practice version immutable' USING ERRCODE='insufficient_privilege';
 ELSIF TG_TABLE_NAME='practice_share_links' THEN
  IF (OLD.workspace_id,OLD.id,OLD.pack_id,OLD.pack_version,OLD.token_hash,OLD.owner_membership_version,OLD.not_before,OLD.expires_at,OLD.created_at,OLD.created_by,OLD.last_mint_nonce_hash)
    IS DISTINCT FROM (NEW.workspace_id,NEW.id,NEW.pack_id,NEW.pack_version,NEW.token_hash,NEW.owner_membership_version,NEW.not_before,NEW.expires_at,NEW.created_at,NEW.created_by,NEW.last_mint_nonce_hash)
    OR (NOT OLD.active_slot AND NEW.active_slot) OR NEW.attempts_started<OLD.attempts_started OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
   RAISE EXCEPTION 'practice link immutable' USING ERRCODE='check_violation';
  END IF;
 ELSIF TG_TABLE_NAME='practice_attempts' THEN
  IF (OLD.workspace_id,OLD.id,OLD.link_id,OLD.pack_id,OLD.pack_version,OLD.started_at,OLD.delete_after,OLD.question_count)
   IS DISTINCT FROM (NEW.workspace_id,NEW.id,NEW.link_id,NEW.pack_id,NEW.pack_version,NEW.started_at,NEW.delete_after,NEW.question_count)
   OR (OLD.state='closed' AND NEW IS DISTINCT FROM OLD)
   OR (NEW.resume_hash IS DISTINCT FROM OLD.resume_hash AND NOT (NEW.state='closed' AND NEW.resume_hash IS NULL))
   OR (OLD.state='submitted' AND (NEW.state='active' OR (NEW.completed_at,NEW.server_score,NEW.current_page_key) IS DISTINCT FROM (OLD.completed_at,OLD.server_score,OLD.current_page_key))) THEN
   RAISE EXCEPTION 'practice attempt immutable' USING ERRCODE='check_violation';
  END IF;
 ELSIF TG_TABLE_NAME='practice_answers' THEN
  IF TG_OP='DELETE' THEN
   IF pg_trigger_depth()>1 THEN RETURN OLD; END IF;
   RAISE EXCEPTION 'practice answers delete with attempt only' USING ERRCODE='insufficient_privilege';
  END IF;
  IF TG_OP='UPDATE' AND (OLD.finalized OR (NEW.workspace_id,NEW.attempt_id,NEW.page_key) IS DISTINCT FROM (OLD.workspace_id,OLD.attempt_id,OLD.page_key)) THEN
   RAISE EXCEPTION 'practice answer finalized' USING ERRCODE='insufficient_privilege';
  END IF;
  IF EXISTS(SELECT 1 FROM practice_attempts WHERE workspace_id=NEW.workspace_id AND id=NEW.attempt_id AND state<>'active') THEN
   RAISE EXCEPTION 'practice answer finalized' USING ERRCODE='insufficient_privilege';
  END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER practice_pack_identity BEFORE UPDATE ON practice_packs FOR EACH ROW EXECUTE FUNCTION practice_guard();
CREATE TRIGGER practice_version_immutable BEFORE UPDATE OR DELETE ON practice_pack_versions FOR EACH ROW EXECUTE FUNCTION practice_guard();
CREATE TRIGGER practice_source_immutable BEFORE UPDATE OR DELETE ON practice_pack_sources FOR EACH ROW EXECUTE FUNCTION practice_guard();
CREATE TRIGGER practice_link_identity BEFORE UPDATE ON practice_share_links FOR EACH ROW EXECUTE FUNCTION practice_guard();
CREATE TRIGGER practice_attempt_identity BEFORE UPDATE ON practice_attempts FOR EACH ROW EXECUTE FUNCTION practice_guard();
CREATE TRIGGER practice_answer_final BEFORE INSERT OR UPDATE OR DELETE ON practice_answers FOR EACH ROW EXECUTE FUNCTION practice_guard();

CREATE FUNCTION practice_flow_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (OLD.session_hash,OLD.workspace_id,OLD.csrf_hash,OLD.created_at,OLD.expires_at)
  IS DISTINCT FROM (NEW.session_hash,NEW.workspace_id,NEW.csrf_hash,NEW.created_at,NEW.expires_at)
  OR (OLD.link_id IS NOT NULL AND NEW.link_id IS DISTINCT FROM OLD.link_id)
  OR (OLD.state='consumed' AND NEW IS DISTINCT FROM OLD)
  OR (OLD.state='resolved' AND NEW.state='unresolved') THEN
  RAISE EXCEPTION 'practice flow binding immutable' USING ERRCODE='check_violation';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER practice_flow_identity BEFORE UPDATE ON practice_link_sessions FOR EACH ROW EXECUTE FUNCTION practice_flow_guard();
