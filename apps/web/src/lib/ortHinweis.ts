import { ortAnalysieren } from './adresse.js';

/**
 * Der Hinweis unter dem Ort-Feld der Editoren: Was die App aus dem Getippten
 * macht – und was fehlt, damit die Karte genauer findet.
 *
 * Als reine Funktion, weil die Texte Teil des Vertrags mit dem Anwender sind
 * und nicht in drei Oberflächen auseinanderlaufen sollen (Termin,
 * Terminfindung, Umfrage). `gut` färbt den Hinweis grün: erkannt, kein Fehler.
 *
 * `null` heisst: nichts sagen. Das ist bei „Zoom“, „Online“ und „bei mir“ der
 * Fall – ein Hinweis, der zu einer Adresse rät, wäre dort falsch.
 */
export interface OrtHinweisText {
  text: string;
  gut: boolean;
}

export function ortHinweis(ort: string | null | undefined): OrtHinweisText | null {
  const analyse = ortAnalysieren(ort);
  if (analyse.text === '') {
    return {
      text: 'Mit Straße, Hausnummer und Ort lässt sich der Ort später in einer Karten-App öffnen.',
      gut: false,
    };
  }
  const fund = analyse.hauptfund;
  if (fund?.art === 'koordinate') {
    return {
      text: 'Koordinaten erkannt: Wer eingeladen ist, kann die Stelle in seiner Karten-App öffnen.',
      gut: true,
    };
  }
  if (fund?.art === 'adresse') {
    if (fund.sicherheit === 'sicher') {
      return {
        text: 'Adresse erkannt: Wer eingeladen ist, kann sie in seiner Karten-App öffnen.',
        gut: true,
      };
    }
    return fund.luecke === 'strasse'
      ? {
          text: 'Nur Postleitzahl und Ort erkannt. Mit Straße und Hausnummer landet die Karte genau am Ziel.',
          gut: false,
        }
      : {
          text: 'Sieht nach einer Adresse aus. Mit Postleitzahl und Ort findet die Karte sie genauer.',
          gut: false,
        };
  }
  if (analyse.nurWeb) {
    return { text: 'Link erkannt: Wer eingeladen ist, kann ihn antippen.', gut: true };
  }
  if (analyse.ziel) {
    return {
      text: 'Keine Adresse erkannt. Wer eingeladen ist, kann den Ort trotzdem auf der Karte suchen.',
      gut: false,
    };
  }
  return null;
}
