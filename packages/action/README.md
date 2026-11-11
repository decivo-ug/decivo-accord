# decivo Accord – GitHub Action

A red check for `must` violations (for example hard-coded colours in components), with an annotation on the line and the fix, plus a summary on the job page. Only lines the pull request adds are checked.

```yaml
# .github/workflows/accord.yml
name: Accord
on: pull_request
jobs:
  accord:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: decivo-ug/decivo-accord/packages/action@v0
```

Inputs: `register` (default `.accord`), `root`, `version`, `node-version`, and optionally `report-url`, `report-token`.

**Versions:** `@v0` follows the releases of version 0; pin an exact one with `@v0.2.3`. The Action runs the `@decivo/accord-cli` release it belongs to. `version` overrides that with another npm version, and `version: source` builds Accord from the Action's repository instead (run `pnpm/action-setup` before it).

**Send the report to a webhook (optional):** with `report-url`, the Action POSTs the drift report to exactly that https address after every run (`accord report`), also when the check is red. Without `report-url` nothing is sent. `report-token` is optional and goes out as `Authorization: Bearer <token>`; pass it from a secret, for example `secrets.ACCORD_REPORT_TOKEN`, and keep the URL in the variable `ACCORD_REPORT_URL`. Only counts, paths, line numbers, values and token names are sent, never source lines; the format is in [docs/report-format.md](../../docs/report-format.md). To report the main branch too, also run the Action on `push` to `main` (see `templates/github/accord.yml`). Locally: `ACCORD_REPORT_TOKEN=… accord report --url https://…`, or `accord report --json` to look first.

<details><summary>Deutsch</summary>

Roter Check bei Muss-Verstößen (z. B. harte Farbwerte in Komponenten), mit Anmerkung an der Zeile und Ersatzvorschlag; Zusammenfassung auf der Job-Seite. Geprüft werden nur hinzugefügte Zeilen des Pull Requests.

```yaml
# .github/workflows/accord.yml
name: Accord
on: pull_request
jobs:
  accord:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: decivo-ug/decivo-accord/packages/action@v0
```

Eingaben: `register` (Standard `.accord`), `root`, `version`, `node-version`, optional `report-url`, `report-token`.

**Versionen:** `@v0` folgt den Releases der Version 0; eine feste Version gibt es mit `@v0.2.3`. Die Action nutzt das `@decivo/accord-cli`-Release, zu dem sie gehört. `version` setzt eine andere npm-Version, `version: source` baut Accord aus dem Repo der Action (vorher `pnpm/action-setup` ausführen).

**Bericht an einen Webhook senden (optional):** Mit `report-url` schickt die Action nach jedem Lauf den Drift-Bericht per POST an genau diese https-Adresse (`accord report`), auch wenn der Check rot ist. Ohne `report-url` wird nichts gesendet. `report-token` ist optional und geht als `Authorization: Bearer <token>` hinaus; aus einem Secret übergeben, z. B. `secrets.ACCORD_REPORT_TOKEN`, die Adresse in der Variable `ACCORD_REPORT_URL`. Gesendet werden nur Zahlen, Pfade, Zeilennummern, Werte und Token-Namen, nie Quellcode-Zeilen; das Format steht in [docs/report-format.md](../../docs/report-format.md). Damit auch der Hauptbranch gemeldet wird, die Action auch bei `push` auf `main` laufen lassen (siehe `templates/github/accord.yml`). Lokal: `ACCORD_REPORT_TOKEN=… accord report --url https://…` oder `accord report --json` zum Ansehen.

</details>
