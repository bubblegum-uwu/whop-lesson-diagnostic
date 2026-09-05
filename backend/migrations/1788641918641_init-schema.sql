-- Up Migration

CREATE TABLE courses (
  id                  BIGSERIAL PRIMARY KEY,
  whop_course_id      TEXT NOT NULL UNIQUE,
  whop_experience_id  TEXT NOT NULL,
  slug                TEXT NOT NULL,
  title               TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at      TIMESTAMPTZ
);

CREATE TABLE lessons (
  id                  BIGSERIAL PRIMARY KEY,
  course_id           BIGINT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  whop_lesson_id      TEXT NOT NULL,
  title               TEXT NOT NULL,
  lesson_type         TEXT NOT NULL,
  visibility          TEXT,
  chapter_whop_id     TEXT,
  chapter_title       TEXT,
  chapter_order       INTEGER,
  course_order        INTEGER,
  duration_seconds    INTEGER,
  video_asset_status  TEXT,
  video_available     BOOLEAN NOT NULL DEFAULT false,
  source_url          TEXT NOT NULL,
  archived_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (course_id, whop_lesson_id)
);

CREATE INDEX lessons_course_order_idx ON lessons (course_id, chapter_order, course_order);

-- Single-operator system today (one Whop identity drives this app). The
-- singleton is enforced by fixing id=1 rather than by table shape, so a
-- later migration can move to per-user rows (keyed on whop_user_id, already
-- captured below) by dropping the id=1 check instead of restructuring this
-- table.
-- encrypted_access_token / encrypted_refresh_token each hold one AES-256-GCM
-- envelope: a fresh random IV followed by the ciphertext+auth tag. Each
-- secret gets its own IV — reusing one IV column across two different
-- plaintexts under the same key would break GCM's security guarantee.
CREATE TABLE auth_sessions (
  id                       SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  whop_user_id             TEXT,
  encrypted_access_token   BYTEA,
  encrypted_refresh_token  BYTEA NOT NULL,
  access_token_expires_at  TIMESTAMPTZ NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'active',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE auth_sessions;
DROP TABLE lessons;
DROP TABLE courses;
