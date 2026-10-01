# Anforderungen der zweiten Runde (Anwender, wörtlich) und verbindliche Auslegung

## Wörtlich

> An sich gut. Aber es sollten bei videos auch wie beim Foto auch mehrere Bereiche geben, für die separate Masken seperat getrackt werden.
>
> Wechzeichnen geht bei Fotos und videos noch über die kanten der Maske hinaus, was beim freistellen suboptimal ist. Zudem sollten echte Bookeh effekte dabei sichtbar werden (vielleicht normales weichzeichnen und separat bookeh als weiteren slider).
> Beim ziehen mit dem Finger durch die Zeitleiste sollte das live Video flüssiger mitlaufen (das bild anzeigen, aif dem der Finger gerade liegt) und dabei auch die masken anzeigen.
>
> Kommen wir zu events:
> Beim ort sollten adressen erkannt und verlinkt werden (ohne kostenpflichtige apis oder lizenzen) sodass alle die Eingeladen sind diese Adresse mit der kartenapp ihrer wahl öffnen können.
> Bei den Einladungen sollte man neben bestimmten Personen (hier sollten auch wenn keine Person ausgewählt ist alle verfügbaren personen unten stehen, sodass man nicht suchen muss, um einen Namen angezeigt zu bekommen) oder alle auch alle in einem Grupoenchat auswählen können. auswählen können, wobei man danach einzelne Mitglieder abgewählt werden können. Sind alle Personen in eibem Gruppenchat ausgewählt kommt die einladung im Gruppenchat und in den Chats mit den einzelnen Personen (wobei diese einladungen synchronisiert sein sollten, falls das nicht längst der Fall ist). Sonst nur im einzelchat. Beides ist eventuell schon umgesetzt.
> Man sollte einstellen können ob in den einzelchats nach einer Weile (auch mehrfach) erinnert werden soll, falls einladungen noch ausstehen.
>
> Bei Sammlung verknüpfen sollte man nicht nur eine bestehende Sammlung verknüpfen können sondern auch wahlweise eine erstellen können (auch in einem unterordner wobei ich mit ordner sammlungen meine).

## Grundsätze (gelten für alles)

- Kommerzielle App: nur MIT/Apache-2.0/BSD-Abhängigkeiten; KEINE neuen Abhängigkeiten ohne zwingenden
  Grund; keine fremden Skripte, keine fremden Server, keine kostenpflichtigen APIs oder Lizenzen; alles im Gerät
  bzw. auf dem eigenen Server.
- Deutsch: Bezeichner, Kommentare (erklären das WARUM), Oberflächentexte. Stil und Kommentardichte wie im Bestand.
- Entwicklung im zugewiesenen Arbeitsbaum/Zweig. Nicht pushen, keinen PR anlegen.

## Auslegung je Thema

### Videos: mehrere Bereiche mit getrennt verfolgten Masken
Im Code ist das seit der letzten Runde angelegt (jeder Bereich = eine `Maske` in `video/masken.ts`, bis zu 4 je Bild,
8 im Film, jede mit eigener Bahn und eigener Verfolgung). Der Anwender hat es offenbar nicht gefunden oder es
verhält sich an einer Stelle anders als beim Foto. Zu tun: genau prüfen, was der Anwender im Editor sieht und
kann – und jede Lücke zum Foto schliessen (Auffindbarkeit, Bereich wählen ↔ Bahn wählen im Gleichklang,
Bereich anlegen/umbenennen/löschen, je Bereich eigene Regler, getrennte Verfolgung nachweisen).

### Weichzeichnen, Bokeh
Zwei Regler je Bereich (Foto und Video, derselbe Renderer): „Weichzeichnen" (gewöhnlich, sauber an der
Maske begrenzt) und „Bokeh" (echte Linse: Blendenscheibe, Glanzlichter werden sichtbare Scheiben).
Beide dürfen zugleich wirken. Der Effekt darf die Maskenkante nicht überschreiten und keine Farbe von
ausserhalb der Maske hereinholen. Ausserhalb der Maske bleibt das Bild unverändert.

### Wischen durch die Zeitleiste
Beim Ziehen mit dem Finger soll das Bild unter dem Finger flüssig erscheinen – mit Bearbeitung UND Masken.
Gewünscht ist ein Bildspeicher für das Wischen (kleine, komprimierte Bilder des ganzen Films, im Hintergrund
gefüllt), damit nicht jede Stelle einen Sprung im Dekodierer braucht.

### Events: Ort als Adresse
Adressen im Ort erkennen und verlinken, ohne kostenpflichtige APIs/Lizenzen: Links in Karten-Apps
(keine Schlüssel, keine eigene Geokodierung, keine Kartenkacheln von fremden Servern). Jeder Eingeladene wählt
seine Karten-App selbst. Merken der Wahl ist erwünscht.

### Events: Einladen
- Die Liste aller verfügbaren Personen steht immer unter dem Feld (ohne Suche), Suche filtert sie nur.
- Schnellwahl: „Alle", „Niemand", „Gruppenchat …" (wählt dessen Mitglieder; danach einzelne abwählbar).
- Liefern: Sind ALLE Mitglieder eines gewählten Gruppenchats eingeladen (niemand abgewählt), kommt die Einladung
  in den Gruppenchat UND in die Einzelchats mit den einzelnen Personen. Sonst nur in die Einzelchats.
- Die Einladungen in den verschiedenen Chats sind SYNCHRON (Zu-/Absage an einer Stelle gilt überall und
  aktualisiert alle Karten).
- Ob das schon umgesetzt ist, ist unklar: Bestand prüfen, nur ergänzen, was fehlt. (Bekannt: heute bindet ein Termin
  an EINEN Chat; der Server lädt dann immer alle Chatmitglieder ein und postet nur dort eine Karte.)

### Events: Erinnern an ausstehende Antworten
Einstellbar je Termin: in den Einzelchats nach einer Weile erinnern, wenn die Antwort aussteht – auch mehrfach.
Nur an die, die noch nicht geantwortet haben; hört auf bei Antwort, Löschen/Absage des Termins, Terminbeginn,
erreichter Anzahl.

### Events: Sammlung verknüpfen
Zusätzlich zum Verknüpfen einer bestehenden Sammlung: eine neue Sammlung anlegen (Name, vorbelegt mit dem
Termintitel), wahlweise in einer bestehenden Sammlung als Unterordner („Ordner" = Sammlungen), und verknüpfen.
