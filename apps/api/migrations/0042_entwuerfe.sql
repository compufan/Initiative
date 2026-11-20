-- Entwürfe je Chat, geräteübergreifend.
--
-- Was man in einen Chat getippt, aber nicht abgeschickt hat, gehört der
-- Person und dem Chat – also an die Mitgliederzeile. `draft_updated_at` ist der
-- Stand des Geräts, das zuletzt geschrieben hat: Der neueste gewinnt, ein
-- älterer Stand (ein Gerät, das offline weitergetippt hat und spät meldet)
-- überschreibt keinen neueren. Ein geleerter Entwurf behält seinen Zeitpunkt,
-- damit ein alter Stand ihn nicht wieder auferstehen lässt.
alter table conversation_members
  add column if not exists draft text,
  add column if not exists draft_reply_to_id uuid,
  add column if not exists draft_updated_at timestamptz;
