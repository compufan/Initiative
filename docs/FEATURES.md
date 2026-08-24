# Funktionen aus Nutzersicht

Was die App kann – ohne Code, nach Modulen sortiert. Wer wissen will, wie es
technisch funktioniert, liest [ARCHITECTURE.md](ARCHITECTURE.md); wer es
erweitern will, [EXTENDING.md](EXTENDING.md).

Initiative ist eine **installierbare Web-App (PWA)**: Sie läuft im Browser,
lässt sich auf iPhone, Android und Desktop wie eine normale App auf den
Startbildschirm legen und funktioniert auch ohne Netz weiter.

---

## Konto und Anmeldung

- Registrierung mit **Benutzername, Anzeigename und Passwort** – keine
  Telefonnummer, keine E-Mail-Adresse, keine Bestätigungsmail.
- Je nach Einstellung des Servers ist die Registrierung **offen**, nur mit
  **Einladungscode** möglich oder **geschlossen**.
- Angemeldet bleibst du dauerhaft; die Sitzung erneuert sich im Hintergrund.
  Abmelden beendet sie nur auf diesem Gerät.
- **Profil**: Profilbild (direkt aus Kamera oder Galerie), Anzeigename und ein
  kurzer Text „Über mich". Wer kein Bild hinterlegt, bekommt automatisch
  Initialen in einer festen eigenen Farbe.
- **Passwort ändern** in den Einstellungen, mit Bestätigung des alten Passworts.

## Chats

- **Direktchats** mit einer Person und **Gruppen** mit beliebig vielen.
- Gruppen haben **Name, Bild und Rollen**: Besitzer, Admin, Mitglied. Admins
  laden ein und entfernen; jeder kann selbst gehen.
- Die Chatliste zeigt **letzte Nachricht, Uhrzeit und Anzahl ungelesener
  Nachrichten**; der aktuellste Chat steht oben.
- **Personen suchen** über den Benutzernamen, um einen neuen Chat zu beginnen.
  Ein zweiter Direktchat mit derselben Person entsteht nicht – du landest im
  bestehenden.

### Stummschalten

- Ein Chat lässt sich **auf Zeit stumm schalten** – für ein paar Stunden, bis
  morgen oder dauerhaft.
- Stumm heißt: **keine Push-Benachrichtigung**. Neue Nachrichten kommen weiter
  an, der Chat wird weiter als ungelesen markiert, es bleibt nur still.
- In der Chatliste steht ein Symbol daneben, damit klar ist, warum es ruhig ist.
- Die Einstellung gilt **nur für dich** – niemand sonst merkt etwas davon.

### Archivieren

- Chats, die du nicht löschen, aber auch nicht mehr sehen willst, wandern ins
  **Archiv**.
- Archivierte Chats verschwinden aus der Hauptliste und **zählen nicht mehr in
  den Ungelesen-Zähler** der unteren Leiste.
- Sie bleiben vollständig erhalten und lassen sich jederzeit zurückholen.
- Auch das gilt nur für dich.

## Nachrichten

- **Text** mit Emoji, bis 8000 Zeichen.
- **Antworten** auf eine bestimmte Nachricht – die zitierte steht darüber, ein
  Tipp darauf springt zum Original.
- **Bearbeiten** eigener Nachrichten; die geänderte Nachricht ist als bearbeitet
  gekennzeichnet.
- **Löschen** eigener Nachrichten – bei allen. Statt einer Lücke bleibt „Diese
  Nachricht wurde gelöscht" stehen, damit der Verlauf nachvollziehbar bleibt;
  Text und Anhänge sind weg. In Gruppen dürfen Besitzer und Admins auch fremde
  Nachrichten löschen.
- **Kopieren** per langem Druck auf die Nachricht.
- **Suchen** über alle Chats oder innerhalb eines Chats.
- Lange Verläufe laden beim Hochscrollen **automatisch nach**.
- Eine Markierung **„Neue Nachrichten"** zeigt, wo du beim letzten Mal aufgehört
  hast.

### Reaktionen

- Langer Druck auf eine Nachricht öffnet die Reaktionsleiste:
  👍 ❤️ 😂 😮 😢 🙏 🎉 🔥
- Ein zweiter Tipp auf dieselbe Reaktion nimmt sie zurück.
- Unter der Nachricht stehen alle Reaktionen mit Anzahl; wer reagiert hat, ist
  ablesbar.
- Reaktionen erscheinen bei allen **sofort**, ohne die Ansicht neu zu laden.

### Lesebestätigungen

- Jede eigene Nachricht zeigt ihren Zustand: **wird gesendet** (Uhr),
  **gesendet** (Haken) oder **fehlgeschlagen**.
- Gelesen wird **automatisch gemeldet**, sobald eine Nachricht auf dem
  Bildschirm war – niemand muss etwas antippen.
- Daraus entstehen der **Ungelesen-Zähler** in der Chatliste und die Linie
  **„Neue Nachrichten"** an der Stelle, an der du zuletzt aufgehört hast.
- Der Lesestand wandert nur vorwärts – ein Blick in ältere Nachrichten setzt
  ihn nicht zurück. Er gleicht sich über alle deine Geräte ab.
- **Tipp-Anzeige**: Während jemand schreibt, siehst du das im Chat. Sie
  verschwindet nach wenigen Sekunden von selbst, auch wenn die Verbindung
  abbricht.
- **Online-Status**: Ob ein Kontakt gerade online ist beziehungsweise wann er
  zuletzt gesehen wurde.

## Medien

### Kamera

- Kamera direkt in der App, **ohne Umweg über die Foto-App**.
- Umschalten zwischen **Front- und Rückkamera**.
- **Foto aufnehmen oder Video drehen**, jeweils im Vollbild mit Live-Vorschau.
- Aufgenommenes vor dem Senden ansehen, verwerfen oder abschicken.
- Optional ein Text dazu.

### Fotos und Videos

- Auswahl aus der Galerie, auch **mehrere auf einmal**.
- Bilder werden vor dem Senden auf höchstens **1920 Pixel Kantenlänge**
  verkleinert – das spart Datenvolumen und geht auch bei schlechtem Netz zügig.
- Vom Video entsteht ein **Vorschaubild**, damit im Chat nicht nur ein schwarzes
  Rechteck steht.
- Jedes Bild kommt mit einer winzigen Unschärfe-Vorschau, die sofort da ist,
  während das eigentliche Bild noch lädt.
- Ein Tipp öffnet die **Lightbox**: Vollbild, Zoom per Doppeltipp oder zwei
  Fingern, Verschieben im gezoomten Bild, nach unten wischen zum Schließen.

### Sprachnachrichten

- Ein Tipp startet die Aufnahme, ein zweiter beendet sie – mit laufender
  **Aufnahmedauer**.
- Vor dem Senden lässt sich die Aufnahme **anhören, verwerfen oder abschicken**.
- Im Chat erscheint eine **Wellenform** mit Abspielknopf und Fortschritt.
- Aufnahme ist auch **ohne Netz** möglich; die Nachricht geht raus, sobald du
  wieder Empfang hast.

### Dateien

- Beliebige Dateien bis 100 MB, mit Name, Größe und Symbol nach Dateityp.
- **Herunterladen** mit einem Tipp.

### Grenzen

| Art                     | Maximale Größe |
| ----------------------- | -------------- |
| Bild                    | 25 MB          |
| Video                   | 200 MB         |
| Sprachnachricht / Audio | 50 MB          |
| Datei                   | 100 MB         |
| Sticker                 | 2 MB           |

Bis zu 10 Anhänge pro Nachricht.

## Sticker

- **Sticker-Tastatur** im Chat: alle installierten Pakete auf einen Blick.
- **Eigene Sticker** im Studio bauen:
  - Bild aus Galerie oder Kamera als Quelle,
  - **Freistellen** – Hintergrund wegwischen,
  - Zuschneiden und Verschieben,
  - **Text** hinzufügen,
  - **weiße Kontur** mit einstellbarer Stärke,
  - fertigen Sticker in ein Paket speichern.
- **Pakete** anlegen, umbenennen, Titelbild wählen, löschen.
- Ein Paket **öffentlich** stellen, damit andere es finden und installieren
  können; installierte Pakete lassen sich jederzeit wieder entfernen.
- Öffentliche Pakete **durchsuchen** unter „Sticker entdecken".

## Kalender

- **Monatsansicht** mit Punkten an Tagen mit Terminen und **Agenda** als
  chronologische Liste.
- Termine mit **Titel, Beschreibung, Ort, Farbe** und Ganztags-Option.
- Ein Termin kann **an einen Chat gebunden** sein (alle Mitglieder sehen ihn) –
  oder privat bleiben.
- **Zu- und Absagen**: ja, nein, vielleicht. Wer wie geantwortet hat, steht beim
  Termin. Änderungen sind jederzeit möglich.
- **Serientermine**: täglich, wöchentlich, monatlich oder jährlich, auf Wunsch
  nur jede zweite oder dritte Runde, bei wöchentlich mit festen Wochentagen.
  Ende wahlweise nie, nach einer Anzahl oder an einem Datum. Die einzelnen
  Termine der Reihe sind in der Detailansicht aufgelistet.
- **Erinnerungen** pro Termin, zum Beispiel 1 Stunde und 1 Tag vorher.
- Ein neuer Termin wird auf Wunsch **als Karte in den Chat** gepostet – dort
  kann direkt zu- oder abgesagt werden.
- **Einzelnen Termin exportieren** (`.ics`) und in jede Kalender-App übernehmen.

### Kalender abonnieren

- Unter **Profil → Kalender abonnieren** gibt es eine persönliche Adresse.
- In iOS, Android, Google Kalender oder Outlook als Abo eingetragen, erscheinen
  **alle deine Termine in der Kalender-App des Handys** und aktualisieren sich
  von selbst.
- Ist die Adresse irgendwo gelandet, wo sie nicht hingehört, erzeugst du mit
  einem Tipp eine neue – die alte funktioniert danach nicht mehr.

## Umfragen

- Umfrage direkt im Chat: **Frage, beliebig viele Antwortmöglichkeiten**.
- **Einfach- oder Mehrfachauswahl.**
- **Anonym** möglich: dann sind nur die Zahlen sichtbar, nicht wer was gewählt hat.
- Optional dürfen alle **eigene Antworten ergänzen**.
- Balken zeigen den Stand in Echtzeit, während andere abstimmen.
- Die eigene Stimme lässt sich ändern oder zurücknehmen.
- Wer die Umfrage erstellt hat, kann sie **schließen** und wieder **öffnen**.

## Terminfindung

- Die Variante der Umfrage für die Frage „Wann passt es euch?".
- Mehrere **Zeitvorschläge** über einen Mini-Kalender wählen.
- Jeder antwortet je Vorschlag mit **ja / vielleicht / nein**.
- Eine Übersicht zeigt alle Personen und Vorschläge nebeneinander; der beste
  Termin ist hervorgehoben (ja zählt voll, vielleicht halb).
- Mit einem Tipp wird aus dem Gewinner ein **echter Termin im Kalender** – alle
  mit „ja" sind automatisch eingeladen, die Terminfindung wird geschlossen.

## Mini-Spiele

- **Tic Tac Toe** und **Vier gewinnt**, direkt aus dem Chat gestartet.
- Die Partie erscheint als Karte im Chat und lässt sich von dort öffnen.
- Züge sind sofort bei allen sichtbar; wer am Zug ist, steht unter dem Brett.
- **Der Server prüft jeden Zug** – Schummeln über die Entwicklerkonsole geht nicht.
- Wer am Zug ist, bekommt eine **Benachrichtigung** („Du bist am Zug").
- Partien lassen sich **abbrechen**, und nach dem Ende gibt es **Revanche**.
- Unter **Spiele** stehen alle laufenden Partien und der Spielekatalog.
- Kennt deine App-Version ein Spiel noch nicht, zeigt sie das freundlich an,
  statt abzustürzen.

## Benachrichtigungen

- **Push-Benachrichtigungen** für neue Nachrichten, auch wenn die App
  geschlossen ist.
- Antippen öffnet direkt den passenden Chat.
- Mehrere Nachrichten aus demselben Chat **ersetzen einander**, statt sich zu
  stapeln.
- In den Einstellungen wählbar: **Vorschau des Textes anzeigen** oder nur
  „Neue Nachricht", sowie **Ton an oder aus**.
- Stummgeschaltete Chats werden übersprungen.
- Ein **Testknopf** schickt dir eine Benachrichtigung, damit du siehst, dass es
  funktioniert.
- **Auf dem iPhone** funktioniert das erst ab iOS 16.4 und nur, wenn die App
  über Safari zum Home-Bildschirm hinzugefügt wurde. Die App erklärt das an
  Ort und Stelle, statt einen toten Schalter zu zeigen.

## Offline

Die App ist dafür gebaut, dass Funklöcher, U-Bahn und Flugmodus nicht stören.

- **Sie startet ohne Netz.** Die Oberfläche liegt auf dem Gerät.
- **Chats und die letzten 200 Nachrichten pro Chat** sind gespeichert und
  lesbar.
- **Bereits gesehene Bilder, Videos und Sprachnachrichten** bleiben abspielbar –
  Medien werden dauerhaft zwischengespeichert.
- **Schreiben geht weiter.** Nachrichten – auch Fotos aus der Kamera und
  Sprachnachrichten – landen in einer **Ausgangsbox** und werden mit einer Uhr
  markiert.
- **Sobald Netz da ist**, geht alles automatisch raus, in der richtigen
  Reihenfolge. Nichts wird doppelt zugestellt, auch wenn die Verbindung mitten
  im Senden abbricht.
- Scheitert eine Nachricht dauerhaft, ist sie als **fehlgeschlagen** markiert und
  lässt sich erneut senden oder verwerfen.
- Ein **Verbindungsanzeiger** sagt jederzeit, woran man ist: verbunden,
  verbindet, offline.
- Nach einer Trennung holt die App **automatisch alles Verpasste** nach.
- Der Offline-Speicher lässt sich in den Einstellungen leeren, ohne sich
  abzumelden.

## Auf dem Gerät installieren

- **iPhone/iPad**: Safari → Teilen → „Zum Home-Bildschirm". Danach startet
  Initiative im Vollbild mit eigenem Symbol.
- **Android**: Chrome zeigt „App installieren" an, oder Menü → „App
  installieren".
- **Desktop**: Chrome/Edge bieten die Installation in der Adressleiste an.
- Die App merkt sich, dass sie installiert ist, und blendet den Hinweis danach
  aus.
- **Schnellzugriffe** beim langen Drücken auf das App-Symbol: Neuer Chat,
  Kalender, Spiele.
- **Teilen-Ziel**: Aus Galerie oder einer anderen App heraus „Teilen →
  Initiative" wählen, um ein Foto direkt in einen Chat zu schicken.
- Nach einem Update fragt die App, ob sie neu laden darf – **nichts wird dir
  mitten im Tippen weggetauscht**.

## Aussehen und Bedienung

- **Hell, Dunkel oder wie das System** – umschaltbar in den Einstellungen.
- Jedes Konto hat eine **feste eigene Farbe**, an der man Profilbilder ohne Foto
  und Spielsteine sofort erkennt.
- Für Handys entworfen: **große Touch-Ziele**, untere Navigationsleiste,
  Rücksicht auf Notch und Home-Indikator.
- **Wischen und langes Drücken** statt versteckter Menüs.
- Bedienbar mit **Tastatur und Screenreader**: sinnvolle Beschriftungen,
  sichtbarer Fokus, Escape schließt jedes Sheet.
- Läuft ebenso auf dem Desktop – die Ansicht wird dort breiter, nicht anders.

## Datenschutz und Sicherheit

- **Keine Telefonnummer, keine E-Mail-Adresse, kein Adressbuch-Abgleich.**
- Passwörter werden mit **Argon2id** gespeichert – das Klartextpasswort verlässt
  nie den Anmeldevorgang.
- Zugriff auf einen Chat hat **nur, wer Mitglied ist**; jede Anfrage prüft das
  einzeln.
- Medien liegen hinter **kurzlebigen, nicht erratbaren Links**.
- Kein Tracking, keine Werbung, keine Weitergabe an Dritte.
- Der Server gehört dir: Initiative ist **selbst gehostet** (siehe
  [DEPLOYMENT.md](DEPLOYMENT.md)) und steht unter der [MIT-Lizenz](../LICENSE).

---

## Was (noch) nicht geht

Ehrlichkeitshalber:

- Keine **Sprach- oder Videoanrufe**.
- Keine **Ende-zu-Ende-Verschlüsselung** – der Server kann Inhalte lesen.
  Transport und Speicherung sind gesichert, aber das ist etwas anderes.
- Keine **Statusmeldungen/Stories**.
- Gelöschte Nachrichten hinterlassen sichtbar den Hinweis „gelöscht" – sie
  verschwinden nicht spurlos aus dem Verlauf.
- Kein **Export** des kompletten Verlaufs über die Oberfläche.
