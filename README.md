# FCJJ – die App

Spiele, Ergebnisse, Tabellen und Kalender-Abos aller Mannschaften des **FC Jeunesse Junglinster**,
automatisch von der FLF. Eine einzige Webseite (`index.html`), die Daten holt GitHub selbst.

Idee und FLF-Schnittstelle nach dem Vorbild von https://fckoeppchen.github.io/ (FC Koeppchen).

## So kommt die App ins Netz (einmalig, ca. 10 Minuten)

1. **GitHub-Konto** anlegen (github.com). Am schönsten ist eine eigene Organisation, z. B. `fcjj`
   (Profilbild → *Your organizations* → *New organization*, kostenlos). Dann heißt die App später
   **https://fcjj.github.io/**.
2. **Neues Repository** in dieser Organisation, Name genau **`fcjj.github.io`** (bzw. `<name>.github.io`),
   *Public*.
3. **Dateien hochladen**: *Add file → Upload files*, den ganzen Inhalt dieses Ordners hineinziehen, *Commit*.
   Achtung: Der Ordner `.github` ist am Mac/PC oft versteckt und kommt dann nicht mit. Prüfen, ob es im
   Repo `.github/workflows/abruf.yml` gibt. Wenn nicht: *Add file → Create new file*, als Namen
   `.github/workflows/abruf.yml` eintippen und den Inhalt der Datei hineinkopieren.
4. **Settings → Actions → General** → ganz unten *Workflow permissions*: **Read and write permissions** → *Save*.
5. **Settings → Pages** → *Source: Deploy from a branch* → Branch **main**, Ordner **/ (root)** → *Save*.
6. **Actions** → links **FLF-Daten** → **Run workflow**. Nach 3–5 Minuten stehen die Daten in
   `data/fussball.json`, kurz danach in der App.

Danach läuft alles von selbst: am Wochenende stündlich, unter der Woche morgens und abends.

## Was die App beim ersten Lauf selbst herausfindet

- die FLF-Nummer des Vereins,
- welche Altersklassen der Verein hat (Bambinis, Pupilles, Poussins, Minimes, Scolaires, Cadets,
  Juniors, WU11, WU13, WU15, Seniors, Réserves). Steht im Protokoll des Laufs (Actions → Lauf → *abruf*)
  unter „Altersklasse …“. Fehlt eine Mannschaft, diese Zeilen bitte weitergeben.

Die **Bambinis** stehen nicht im FLF-Extranet, nur als PDF auf flf.lu. Sie werden aus den PDFs gelesen.

## Ändern

- Reihenfolge und Namen der Reiter: `KATS` in `tools/abruf.mjs`.
- Aussehen: oben in `index.html` (Farben unter `:root`). Nach jeder Änderung `FASSUNG` unten hochzählen.
- App aufs Handy: Seite in Safari öffnen → Teilen → *Zum Home-Bildschirm*.

Test: `node test/abruf.mjs <fussball.json mit FLF-Daten>`.
