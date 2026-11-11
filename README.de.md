# decivo Accord

**Das Register für Design-Entscheidungen, gegen das Menschen und Agenten prüfen.** Für Figma, Pencil, Claude Design und Code.

[English](README.md) · [Demo](examples/demo/) · [Prinzipien](CLAUDE.md) · MIT

Design-Tokens leben meist an vier Orten gleichzeitig: in einer Figma-Datei, in einem Werkzeug für Entwürfe, in einer Token-Datei und im CSS, das ausgeliefert wird. Sync-Werkzeuge kopieren Werte zwischen ihnen hin und her, und wer zuletzt schreibt, gewinnt. Accord macht es anders. Ein **Register** im Repository (`.accord/`, [DTCG 2025.10](https://www.designtokens.org/)) ist die Wahrheit. Figma, Pencil, Claude Design und Code sind Arbeitsflächen davor. Eine Änderung auf einer Arbeitsfläche wird ein **Vorschlag**. Die Prüfschicht routet ihn nach **Besitz** und **Regeln**: Sicheres geht von selbst durch, alles andere geht an den Menschen, dem die Eigenschaft gehört. Agenten lesen dasselbe Register, samt Regeln und Begründungen, und prüfen sich vor jedem Commit selbst.

## Synchronisieren oder entscheiden

| | Übliche Token-Synchronisation | decivo Accord |
| --- | --- | --- |
| Wahrheit | das Werkzeug, das zuletzt geschrieben hat | ein Register in Git, geprüft wie Code |
| Eine Designerin ändert einen Wert | wird in den Code kopiert (oder aus dem Code überschrieben) | ein Vorschlag; Sicheres geht durch, der Rest an den Besitzer |
| Wer darf was ändern | alle, von überall | ein Besitzer pro Eigenschaft: `design` (Werte), `code` (Verhalten, API), `register` (Namen, Regeln, Löschungen) |
| Ein neuer Zwischenton | wird ausgeliefert | verletzt D-002 („jede neue Farbe ist eine Entscheidung“); Design entscheidet |
| Eine in Figma gelöschte Variable | verschwindet aus dem Code | „in Figma gelöscht“; Löschungen und Breaking Changes brauchen immer einen Menschen, fest im Code |
| Beide Seiten haben geändert | wer zuletzt schreibt, gewinnt | Dreiwege-Abgleich gegen den letzten Stand: in Figma, im Register oder in beiden geändert |
| Coding-Agenten | raten aus dem Code | MCP-Server: Tokens, Verträge, Entscheidungen mit `why`; `check_change` vor jedem Commit |
| Variablen aus Figma holen | Plugin oder die REST-API nur mit Enterprise-Plan | liest `.fig`-Dateien direkt oder jeden gängigen Export |
| Verlauf | `git blame` auf erzeugten Dateien | ein Changelog der Entscheidungen: wer, wann, warum |

## In fünf Minuten ansehen

```sh
pnpm install && pnpm build
ACCORD_LANG=de bash examples/demo/run.sh
```

Die Demo kopiert eine kleine App mit einem Figma-Export in einen temporären Ordner und spielt die Designerin: Karten werden runder (geht durch), ein neuer Blauton (Design entscheidet), eine gelöschte Variable (immer ein Mensch). Dazu kommen eine harte Farbe im Code mit Korrekturvorschlag und die Regeln für Agenten.

## Schnellstart

Voraussetzungen: Node.js 22 oder neuer (22.15+ für die neuesten `.fig`-Dateien) und git.

```sh
npm install -g @decivo/accord-cli   # oder jeden Befehl mit npx @decivo/accord-cli

cd ~/dein-produkt
accord init --dry-run   # zeigt, was Accord findet und schreiben würde
accord init             # legt .accord/ aus Code, Token-Dateien, Figma oder Pencil an
accord diff             # Drift zwischen Register und Code
accord export           # DESIGN.md, AGENTS.md, CLAUDE.md-Block, CSS, CHANGELOG.md
accord ui               # die Oberfläche im Browser, für die Menschen, die entscheiden
```

`accord init` übernimmt, was da ist. Die Startquelle entscheidet, wer gewinnt, wo sich die heutigen Quellen widersprechen:

- **Code** gewinnt, wenn der Code CSS-Variablen definiert: CSS, Tailwind v4 `@theme`, shadcn/ui.
- **Token-Dateien** gewinnen sonst: DTCG, auch in der älteren Entwurfsnotation, oder Tokens Studio. Bei mehreren Sets wird das Standard-Set übernommen; ein dunkles Set wird zum Kontext dark, weitere (Marken) werden benannt.
- **Design** gewinnt mit `--from design` oder `--figma <Datei oder Ordner>`. Accord startet von selbst damit, wenn es sonst nichts gibt: eine `.fig`-Datei, Figma-Variablen-Exporte oder `.pen`-Dateien.

Was nicht übernommen werden kann, steht als offener Punkt in der Ausgabe und fällt nie still heraus.

## Arbeitsflächen

| Arbeitsfläche | Was Accord liest | Befehle |
| --- | --- | --- |
| **Code** | CSS-Variablen, Tailwind v4 `@theme`, harte Farben und Längen in TS/JS/CSS, Komponentenverträge aus shadcn/ui | `diff`, `check`, `export` |
| **Figma** | `.fig`-Dateien („Lokale Kopie speichern“), Figmas DTCG-Export, die REST-Antwort `variables/local`, Dumps der Plugin-API, variables2json, Tokens Studio; Collections, Modes, Aliase, Scopes, Code-Syntax | `figma status \| propose \| lock` |
| **Pencil** ([pen.dev](https://pen.dev)) | Variablen, Theme-Achsen und harte Farben aus `.pen`-Dateien | `pen status \| propose \| lock` |
| **Claude Design** | Handoff-Bundles (ZIP, Ordner, HTML) und das Design-System-Projekt | `ingest`, `design status \| reset \| lock` |

Alle Design-Arbeitsflächen funktionieren gleich:

- `status` vergleicht dreiseitig mit dem Register und dem letzten Abgleich (`.accord/surfaces.lock.json`).
- `propose` macht aus den Änderungen dort einen Vorschlag.
- `lock` merkt sich den aktuellen Stand als abgeglichen.

Accord schreibt nie in ein Design-Werkzeug. Wo das Werkzeug hinterherhinkt, zeigt `status` das an („im Register geändert, Figma nicht nachgezogen“), und die Menschen im Werkzeug ziehen nach.

**Figma ohne Plugins:** Die `.fig`-Datei (in Figma *Datei → Lokale Kopie speichern*) ins Repo legen. Accord liest die Variablen selbst, ohne Plugin, Export-Skript oder Enterprise-Plan. Das Schema steckt in der Datei, deshalb funktionieren auch neue Figma-Versionen. Der Leser prüft jede Grenze und wird mit beschädigten Dateien gefuzzt. Exporte gehen ebenso: unter `figma/`, als `*.figma.json` oder per `--figma` bzw. `--file`.

## Entscheidungen und Vorschläge

Ein Vorschlag ist eine Datei in `.accord/proposals/`. Ein Mensch entscheidet darüber: auf der Kommandozeile, in der Web-App oder in jedem Werkzeug, das eine `accord.resolution/1`-Datei schreibt oder den Apply-Workflow startet:

```sh
accord figma propose --write      # oder --branch: auf einem eigenen Branch, nie main
accord apply --proposal P-20261019-figma-b680570f --option adopt --by "Dana"
#   adopt  → das Register ändert sich; CSS, DESIGN.md, AGENTS.md und CHANGELOG.md werden neu erzeugt
#   reset  → das Register bleibt; die Arbeitsfläche wird zurückgesetzt
#   reject → der Vorschlag wird verworfen
```

So wird ein Vorschlag geroutet:

- **Automatisch:** Die Arbeitsfläche besitzt, was sie geändert hat, nichts bricht, keine Regel ist verletzt, und die Sicherheit liegt über `routing.auto_apply`.
- **Besitzer entscheidet:** Eine Regel ist verletzt, die Arbeitsfläche besitzt die Eigenschaft nicht, oder beide Seiten haben geändert.
- **Immer ein Mensch:** Löschungen und Breaking Changes. Das steht fest im Code und ist keine einstellbare Schwelle.

Der Besitz steht in `accord.config.yaml`: ein Standard pro Gruppe, mit Ausnahmen pro Token oder Eigenschaft. Namen, Ergänzungen, Löschungen, Deprecations und die Regeln selbst gehören immer dem Register. `accord explain-owner <Pfad>` zeigt, wem ein Pfad gehört und warum.

## Web-App

Die Web-App ist für die Menschen, die entscheiden. Gestartet wird sie im Repository:

```sh
accord ui        # oder: npx @decivo/accord-cli ui
```

Sie öffnet sich im Browser und läuft nur auf deinem Rechner: kein Konto, keine Datenbank, kein Server im Internet. Jedes Projekt hat:

- **Überblick:** der Stand in einem Satz und der nächste Schritt.
- **Entscheidungen:** die offenen Vorschläge als Eingang. Übernehmen, Zurücksetzen und Verwerfen laufen über denselben Code wie `accord apply`. Register, CSS, DESIGN.md, AGENTS.md und CHANGELOG.md ändern sich also genau wie auf der Kommandozeile.
- **Register:** Tokens, Komponenten und Regeln zum Nachschlagen, mit ihren CSS-Variablen.
- **Verbindungen:** welche Arbeitsflächen (Code, Figma, Pencil, Claude Design) Accord liest, und woher.

- Eine Entscheidung ändert Dateien im Arbeitsverzeichnis und committet sie nicht; das bleibt bei dir.
- Ohne Register sagt die App, wie es entsteht (`accord init --dry-run`, dann `accord init`).
- Mehrere Repositories: `accord ui ../shop ../website`. Optionen: `--port <n>` (Standard 4317 oder der nächste freie), `--no-open`.
- Die App ist ein eigenes Paket, [`@decivo/accord-ui`](packages/ui/README.md) (etwa 25 MB), damit die CLI für Agenten und CI klein bleibt. `accord ui` nimmt eine installierte Kopie, sonst lädt es dieselbe Version einmalig über npx.
- Sicherheit: Sie hört nur auf `127.0.0.1`. Die ausgegebene Adresse trägt einen Einmal-Code; wer sie öffnet, bekommt eine Sitzung in diesem Browser, danach ist die Adresse wertlos (Enter im Terminal gibt eine neue aus). Ohne Sitzung, unter einem anderen Hostnamen oder von einer anderen Seite aus antwortet die App nicht, und andere Seiten können sie nicht einbetten. Mit `accord ui` endet immer auch die App.

Aus dem Quellcode, für die Entwicklung: `pnpm install && pnpm build`, dann `pnpm --filter @decivo/accord-web dev` mit `ACCORD_PROJECTS` in `apps/web/.env.local` (siehe `apps/web/.env.example`).

## Für Agenten

```sh
claude mcp add accord -- npx -y @decivo/accord-mcp --root .
```

Werkzeuge: `get_tokens`, `get_component_contract`, `get_decisions` (mit `why`) und `check_change`. Das liefert Verstöße mit Korrektur, z. B. `Card.tsx:12:31 #3c6681 → color.brand (var(--brand))`. `accord export` schreibt `AGENTS.md`, einen Block für `CLAUDE.md` und `DESIGN.md`. Die Prüfschicht ist modellagnostisch: Deterministische Prüfungen laufen ohne Modell, und kein Anbieter ist Pflicht.

## In der CI

Die GitHub Action ([`packages/action`](packages/action/README.md)) schlägt bei Muss-Verstößen in den hinzugefügten Zeilen eines Pull Requests fehl und markiert die Zeile mit der Korrektur. `accord export --check` schlägt fehl, wenn erzeugte Dateien veraltet sind. Vorlagen liegen in [`templates/`](templates/).

Optional schickt die Action den Drift-Bericht nach jedem Lauf an einen eigenen Webhook: `report-url` setzen (eine https-Adresse, z. B. aus `vars.ACCORD_REPORT_URL`) und, falls der Empfänger einen will, `report-token` (aus `secrets.ACCORD_REPORT_TOKEN`). Ohne Adresse wird nichts gesendet. Das Format `accord.report/1` steht in [docs/report-format.md](docs/report-format.md): nur Metadaten, nie Quellcode-Zeilen. Lokal: `accord report --url <url>` oder `accord report --json` zum Ansehen.

## Befehle

Siehe die [englische Befehlsübersicht](README.md#command-reference). Die Texte der CLI sind deutsch bei deutscher Locale, sonst englisch; `ACCORD_LANG=de|en` legt die Sprache fest. Exit-Codes: `0` in Ordnung, `1` Befunde, `2` Fehler.

## Stand

Accord ist jung. Getestet ist es gegen echte Design-Systeme aus öffentlichen Repositories: 13 Figma-Exporte, 19 Pencil-Projekte, `.fig`-Dateien, Tokens-Studio- und DTCG-Sets sowie Claude-Design-Handoffs. Als Nächstes kommen:

- Marken- und Dichte-Modes: weitere Modifier des DTCG-Resolver-Moduls

Hell und Dunkel funktionieren: Das Register hält sie mit dem DTCG-Resolver-Modul (`resolver.json`, `modes/theme/dark.tokens.json`). `init` übernimmt sie aus dem Code (`.dark`, `[data-theme]`, per `@import` eingebundene Themes), aus Figma-Modes und Pencil-Themes; `diff`, `status`, `propose`, `apply`, `design`, die Prüfungen (Kontrast in Hell und Dunkel) und die erzeugten Dateien arbeiten je Kontext.

Mitmachen: [CONTRIBUTING.md](CONTRIBUTING.md). Was sich je Release geändert hat, steht in [CHANGELOG.md](CHANGELOG.md). Sicherheitslücken bitte vertraulich melden: [SECURITY.md](SECURITY.md).

Ein Produkt von [decivo](https://decivo.de) – Clarity before Code.
