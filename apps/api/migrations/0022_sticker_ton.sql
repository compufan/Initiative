-- Ein Sticker darf klingen.
--
-- # Warum der Ton an den STICKER gehört und nicht an die Nachricht
--
-- Der naheliegende Weg wäre, beim Senden einfach einen zweiten Anhang
-- mitzuschicken: `sendMessageSchema` erlaubt `attachmentIds` und
-- `metadata.stickerId` längst nebeneinander, und der Server bindet beides
-- unabhängig. Es hätte keine einzige Schemaänderung gekostet.
--
-- Und wäre trotzdem falsch. Der Ton gehört zum Sticker wie sein Bild: Er muss
-- in der Bibliothek vorhörbar sein, bevor jemand ihn verschickt; er muss beim
-- Weiterleiten mitgehen; und er darf nicht bei jedem Senden neu hochgeladen
-- werden. Hinge er an der Nachricht, wäre nichts davon wahr.
--
-- # Warum kein eingebetteter Ton
--
-- Weil kein Stickerformat eine Tonspur kennt: WebP und GIF beschreiben
-- ausschliesslich Bildpunkte, und ein Sticker steht in einem `<img>`, das
-- auch dann keinen Ton abspielen würde, wenn einer darin stünde. Es MÜSSEN
-- zwei Dateien sein.
--
-- # Warum `set null` und nicht `cascade`
--
-- Das ist der Unterschied zwischen „der Ton ist weg" und „der Sticker ist
-- weg". Die Bildspalte daneben kaskadiert (0001_init.sql), und dort ist das
-- richtig: Ohne Bild gibt es keinen Sticker. Ohne Ton schon – er war ja
-- optional. Mit `cascade` verschwände beim Aufräumen einer Tondatei der ganze
-- Sticker aus allen Gesprächen, in denen er je stand.

alter table stickers
  add column if not exists ton_attachment_id uuid references attachments (id) on delete set null,
  -- Die Dauer liegt doppelt – sie steht auch am Anhang. Das ist Absicht: Die
  -- Sticker-Tastatur zeigt auf jeder Kachel, wie lang der Ton ist, und
  -- braucht dafür sonst einen Verbund über `attachments` auf dem heissesten
  -- Weg der App.
  add column if not exists ton_dauer_ms integer;

comment on column stickers.ton_attachment_id is
  'Optionale Tonspur. `set null`, damit das Loeschen des Tons nicht den Sticker mitnimmt.';
comment on column stickers.ton_dauer_ms is
  'Laenge der Tonspur in Millisekunden. Absichtlich doppelt – spart der Sticker-Tastatur einen Verbund.';

-- # Warum EINDEUTIG und nicht nur ein Index
--
-- Zwei Sticker mit derselben Tondatei sind an sich harmlos. Der Tag, an dem
-- einer von beiden gelöscht wird, ist es nicht: `remove_sticker` räumt den
-- Anhang weg, `on delete set null` macht den zweiten Sticker stumm – ohne
-- Fehler, auch in fremden installierten Paketen, und niemand käme auf die
-- Idee, das mit der Löschung in Verbindung zu bringen.
--
-- Die API prüft das schon (`ton_besitz_pruefen`); diese Bedingung ist der
-- Gürtel zum Hosenträger. Sie kostet nichts, denn der Index, den sie anlegt,
-- ist genau der, den das Aufräumen ohnehin braucht.
create unique index if not exists stickers_ton_idx
  on stickers (ton_attachment_id)
  where ton_attachment_id is not null;
