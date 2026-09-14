-- A PRE-FEDERATION DEPLOYMENT, AS ROWS.
--
-- Loaded by `test/migration-fixture.test.ts` onto a database that has had migrations
-- 0000..0010 applied and NOTHING after — i.e. the schema as it stood the day before
-- `fs_school`, `fs_membership` and the `school_did` columns existed. The test then runs
-- 0011..HEAD and `scripts/backfill-school.ts` over it and asserts what came out.
--
-- WHY ROWS HERE AND SCHEMA FROM THE JOURNAL. A checked-in `pg_dump` of the schema is a
-- second copy of the migrations that rots silently the first time somebody adds a column.
-- The migrations themselves are the schema fixture — replayed to 0010 by the test — and
-- this file is only the DATA a real Boulder had: members, their prefs, the evidence their
-- roles derive from, and one of every kind of row the backfill has to stamp.
--
-- Every DID here is invented and none of them is a prefix of another.

INSERT INTO fs_custodial_account (did, handle, email, key_version, verified_at) VALUES
  ('did:plc:legacy-amira', 'amira.test', 'amira@example.org', 'v1', now()),
  ('did:plc:legacy-bo',    'bo.test',    'bo@example.org',    'v1', now()),
  ('did:plc:legacy-cyrus', 'cyrus.test', 'cyrus@example.org', 'v1', now());

-- The global presence row: before `fs_membership`, this WAS membership.
INSERT INTO fs_member (did, door, first_seen_at, last_seen_at) VALUES
  ('did:plc:legacy-amira', 'custodial', now() - interval '400 days', now()),
  ('did:plc:legacy-bo',    'custodial', now() - interval '200 days', now()),
  ('did:plc:legacy-cyrus', 'oauth',     now() - interval '10 days',  now());

-- Bo opted OUT of the members directory and IN to having their role published. Both
-- answers have to survive the migration: opting somebody back INTO a directory, or
-- losing a consent they gave, are the two failure modes that matter here.
INSERT INTO fs_member_prefs (did, public_role, directory_listing) VALUES
  ('did:plc:legacy-bo', true, false);

-- Admission evidence (the `invite-or-vouch` gate) and role evidence (the tally).
INSERT INTO fs_invite (code, inviter_did, used_by_did, used_at) VALUES
  ('inv-amira', 'did:plc:legacy-founder', 'did:plc:legacy-amira', now()),
  ('inv-bo',    'did:plc:legacy-amira',   'did:plc:legacy-bo',    now());

INSERT INTO fs_attendance_tally (did, attended_confirmed, hosted_events) VALUES
  ('did:plc:legacy-amira', 4, 2),
  ('did:plc:legacy-bo',    1, 0);

INSERT INTO fs_attendance (id, event_uri, attendee_did, attested_by_did, participated) VALUES
  ('att-1', 'at://did:plc:legacy-amira/community.lexicon.calendar.event/e1', 'did:plc:legacy-bo', 'did:plc:legacy-amira', true);

INSERT INTO fs_attendance_rollup (event_uri, participated_count, total_count) VALUES
  ('at://did:plc:legacy-amira/community.lexicon.calendar.event/old', 5, 6);

INSERT INTO fs_attestation (id, attester_did, subject_did, skill_uri) VALUES
  ('vouch-legacy-1', 'did:plc:legacy-bo', 'did:plc:legacy-amira', 'at://did:plc:legacy-taxonomy/freeschool.draft.skill/welding');

INSERT INTO fs_rsvp (id, event_uri, did, status) VALUES
  ('rsvp-legacy-1', 'at://did:plc:legacy-amira/community.lexicon.calendar.event/e1', 'did:plc:legacy-bo', 'going');

INSERT INTO fs_request_rsvp (request_uri, did) VALUES
  ('at://did:plc:legacy-cyrus/freeschool.draft.request/r1', 'did:plc:legacy-bo');

INSERT INTO fs_feedback (id, event_uri, host_did, direction, day) VALUES
  ('fb-legacy-1', 'at://did:plc:legacy-amira/community.lexicon.calendar.event/e1', 'did:plc:legacy-amira', 'positive', current_date);

INSERT INTO fs_moderation_queue (id, action, reason, status, opened_by_did) VALUES
  ('case-legacy-1', 'remove-listing', 'a reason nobody outside this school may read', 'open', 'did:plc:legacy-amira');

INSERT INTO fs_notification_feed (id, did, category, title) VALUES
  ('note-legacy-1', 'did:plc:legacy-bo', 'event.reminder', 'Tomorrow: bike repair table');

INSERT INTO fs_notification_outbox (id, did, category, dedup_key, payload) VALUES
  ('out-legacy-1', 'did:plc:legacy-bo', 'event.reminder', 'dedup-legacy-1', '{}'::jsonb);

INSERT INTO fs_notification_sent (dedup_key, did, category) VALUES
  ('dedup-legacy-0', 'did:plc:legacy-bo', 'event.reminder');

INSERT INTO fs_newsletter_issue (id, month, html, text, status) VALUES
  ('issue-legacy-1', '2026-01', '<p>hi</p>', 'hi', 'sent');

INSERT INTO fs_newsletter_subscription (did, email_ref, token_hash) VALUES
  ('did:plc:legacy-amira', 'amira@example.org', 'hash-legacy-1');

INSERT INTO fs_skill_proposal (id, skill_uri, proposer_did, status) VALUES
  ('prop-legacy-1', 'at://did:plc:legacy-taxonomy/freeschool.draft.skill/welding', 'did:plc:legacy-amira', 'published');

INSERT INTO fs_handoff (id, from_did, token_hash, expires_at) VALUES
  ('handoff-legacy-1', 'did:plc:legacy-amira', 'hash-handoff-1', now() + interval '7 days');

-- These four already carried `school_did` before 0011 and already hold a real DID, so the
-- backfill's `school_did = ''` guard must match NOTHING in them. That is the assertion.
INSERT INTO fs_steward (did, school_did) VALUES
  ('did:plc:legacy-amira', 'did:plc:legacy-school');

INSERT INTO fs_policy_cache (school_did, policy_uri, thresholds) VALUES
  ('did:plc:legacy-school', 'at://did:plc:legacy-school/freeschool.draft.policy/p1',
   '{"memberRequires":"invite-or-vouch","hostMinAttended":2,"publishRoles":true}'::jsonb);

INSERT INTO fs_audit (id, caller_did, school_did, scope, nsid, action, decision, reason, approvals, policy_source, at) VALUES
  ('audit-legacy-1', 'did:plc:legacy-amira', 'did:plc:legacy-school', 'freeschool.draft.policy',
   'com.atproto.repo.putRecord', 'write-policy', 'allow', 'set the hosting bar', '[]'::jsonb, 'policy', now());

INSERT INTO fs_invite_link (id, token_hash, inviter_did, school_did, expires_at) VALUES
  ('link-legacy-1', 'hash-link-1', 'did:plc:legacy-amira', 'did:plc:legacy-school', now() + interval '7 days');

-- `fs_peer.school_did` was NULLABLE before 0012; the migration fills the NULL with '' and
-- then the backfill stamps it. Both halves of that are asserted.
--
-- The second host is the one that used to abort the whole backfill. At 0010 the PK is
-- `host` alone, so there can only be one row for it here; the test writes its STAMPED
-- twin after the migrations, which is exactly when a real deployment gets one
-- (`seedPeersFromEnv` runs at boot on the new code, before anybody back-fills).
INSERT INTO fs_peer (host, source, school_did) VALUES
  ('https://pds.legacy.example', 'env', NULL),
  ('https://pds.shadowed.example', 'env', NULL);
