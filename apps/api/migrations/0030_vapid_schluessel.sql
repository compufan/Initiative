-- Das VAPID-Schlüsselpaar, wenn die Umgebung keines vorgibt.
--
-- WARUM in der Datenbank: Ohne VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY war Push
-- bisher schlicht aus, und die App sagte auf jedem Gerät „Dieser Server
-- verschickt gerade keine Benachrichtigungen“ – auch nachdem die Erlaubnis
-- erteilt war. Jetzt erzeugt der Server beim ersten Bedarf selbst ein Paar.
-- Es MUSS Neustarts und weitere Instanzen überdauern: Jedes Abo im Browser ist
-- an genau diesen öffentlichen Schlüssel gebunden; ein neuer Schlüssel je
-- Start hiesse, dass jedes Gerät nach jedem Deploy stumm wird.
--
-- Genau eine Zeile (`id = 1`). Mehrere Instanzen, die gleichzeitig starten,
-- schreiben mit `on conflict do nothing` und lesen danach – wer zuerst kam,
-- gewinnt, alle benutzen dasselbe Paar.
create table if not exists vapid_schluessel (
  id smallint primary key default 1 check (id = 1),
  public_key text not null,
  private_key text not null,
  erzeugt_am timestamptz not null default now()
);
