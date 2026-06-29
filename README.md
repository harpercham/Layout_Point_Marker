# DSM Working Layout Point Marker

A static browser tool that:

1. Uploads and renders a working-layout PDF.
2. Reads completed point references from the **Daily Point Update** tab in the GH, TH, TKG and ET Google Sheets.
3. Filters by the selected ST number.
4. Locates matching point labels in the PDF text layer.
5. Shows the recorded completion date beside every marker.
6. Changes the completed-point marker to **blue** when the earliest recorded completion date is at least 28 days old.
7. Allows one-time manual placement for point labels that are not extractable.
8. Prints or saves the marked layout through the browser print dialog.

## Run it

### Hosted static page
Upload the whole folder to any static web host, such as GitHub Pages or an internal web server.

### Local test
From this folder, run:

```bash
python -m http.server 8080
```

Then open:

```text
http://localhost:8080
```

Opening `index.html` directly may work, but a local web server is more reliable.

## Google Sheet requirements

The static page does not contain an authentication backend. Each linked Google Sheet must therefore be viewable by the browser:

- Share the Sheet as **Anyone with the link — Viewer**, or
- Publish the relevant Sheet, or
- Export the **Daily Point Update** tab as CSV and use the CSV fallback.

Keep the source tab name as:

```text
Daily Point Update
```

The application scans for these headers:

- `Date`
- `ST`
- `Point Ref`

A row is considered completed when `Date` and `Point Ref` are not blank and the ST matches the selected ST.

## PDF matching

Automatic marking works best when the PDF contains selectable text labels. If the layout is a scanned image, use the **Place** button beside each unmatched point and click its location once. Manual locations are stored in the browser for that PDF file.

## Files

- `index.html` — page structure
- `styles.css` — responsive layout and print styling
- `app.js` — Google Sheet loading, PDF text matching, markers and manual mapping

PDF rendering uses Mozilla PDF.js loaded from a pinned CDN version.


## Completion date and core-ready status

The marker displays the completion date in `DD-MMM-YY` format.

The completed-point marker changes from green to blue when the point has been completed for at least **28 calendar days**, measured from the earliest valid completion date recorded for that point to the current date on the device running the page.

Numeric dates are interpreted in Singapore-style `DD/MM/YYYY` when the format is ambiguous. ISO dates such as `YYYY-MM-DD` are also supported.
