-- Einmal-Tickets für den Aufbau der Echtzeit-Leitung.
--
-- Der WebSocket bekam bisher das Zugriffstoken in der Adresse (`?token=`).
-- Ein Browser kann beim Aufbau keinen `Authorization`-Kopf setzen, und so
-- stand ein volles Zugangstoken in jedem Protokoll eines Zwischenknotens
-- (Caddy, Fly-Proxy, CDN), der die Adresse mitschreibt – eine Viertelstunde
-- lang ein Schlüssel zum ganzen Konto.
--
-- Stattdessen holt sich der Client mit dem Token im Kopf ein Ticket
-- (`POST /realtime/ticket`), das 30 Sekunden gilt und beim ersten Gebrauch
-- verbraucht wird. In einem Protokoll ist es danach wertlos.
--
-- In der Datenbank und nicht im Speicher eines Prozesses: Bei mehreren
-- Maschinen landet das Ausstellen nicht zwingend dort, wo danach die
-- Leitung aufgebaut wird. Gespeichert ist nur der Hash.
--
-- Ohne Index auf `user_id`: Die Zeilen leben 30 Sekunden, die Tabelle ist
-- fast immer leer; abgelaufene räumt das Ausstellen gleich mit ab.
create table if not exists echtzeit_tickets (
  hash text primary key,
  user_id uuid not null references users (id) on delete cascade,
  gueltig_bis timestamptz not null
);
