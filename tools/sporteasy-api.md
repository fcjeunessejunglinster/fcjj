# SportEasy-API (inoffiziell, erkundet am 16.11.2026)

Keine öffentliche Doku. `https://api.sporteasy.net/` selbst antwortet mit 404 (JSON). Gefunden über die SportEasy-Webseite
(angemeldet, Cookie-Sitzung). Alles nur lesen (GET).

## Mannschaften

- Eine SportEasy-Mannschaft je Altersklasse, nicht je FLF-Team. Beispiel: „Minimes U13 26-27“
  (`fc-jeunesse-junglinster5-minimes-u131.sporteasy.net`) = Team-id **3783746** und enthält die Spiele von
  Minimes 1, 2 und 3. Welches FLF-Team spielt, steht in `category.localized_name` (z. B. „Minimes 1 -Phase 2“).
- WU11, WU13, WU15: Team-ids noch offen.

## Termine

`GET /v2.1/teams/{team}/events/` – 20 Termine um heute herum, Blättern über `_links.next` / `_links.prev` (`?c=…`).
Pro Termin u. a.:
- `id`, `start_at`, `end_at`, `is_past`, `is_cancelled`, `name`
- `category.type`: `training`, `championship_match`, `cup_match`, … ; `category.localized_name`
- `opponent_left` / `opponent_right`: `full_name`, `short_name`, `is_home`, `is_current_team`, `score` (Text oder null),
  `match_outcome` (`victory`/`defeat`/…)

`GET /v2.1/teams/{team}/events/{event}/` – Einzeltermin, zusätzlich `live_stats` (`start_at`, `end_at` = Start/Ende der
Live-Erfassung, `end_at` null solange live) und `_links.read_live_stats`.
Achtung: enthält auch Anwesenheiten mit E-Mail, Telefon, Geburtsdatum der Kinder – **nie an die App durchreichen**.

## Live-Ticker

`GET /v2.1/teams/{team}/events/{event}/live-stats/events/` (Premium, beim Verein vorhanden)
→ `{ count, results: [ … ] }`, pro Aktion:
- `action_slug_name` (z. B. `football_goal`), `action_localized_name`
- `time` in **Sekunden** seit Anpfiff der Halbzeit?/des Spiels (zu prüfen), `period` (1, 2)
- `opponent`: `opponent_left` / `opponent_right` (welche Seite)
- `profile`: Torschütze (nur bei eigener Mannschaft, sonst null) – nur Vorname weitergeben, wenn überhaupt
- `is_missed`

## Anmeldung

Noch offen: wie sich ein Programm (Cloudflare-Worker, Secrets `SE_USER` / `SE_PASS`) anmeldet. Nächster Schritt:
Netzwerk-Mitschnitt beim Anmelden auf sporteasy.net (Passwort tippt der Nutzer selbst).
