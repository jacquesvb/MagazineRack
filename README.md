# Magazine Rack

A desktop catalog for organizing and reading PDF publications hosted on Internet Archive.

## Features

- Create collections with descriptions and custom image thumbnails.
- Import Archive.org metadata from an item page or a direct PDF URL.
- Edit publication details and use a custom JPG, PNG, GIF, or WebP cover image or the built-in fallback artwork.
- Browse the catalog in tile or list view, search, and sort publications.
- Read PDFs in an in-app PDF.js reader and save them to the app's local data directory for offline reading.
- Persist the catalog in SQLite in Tauri; the browser preview uses local storage as a development fallback.

## Requirements

- Node.js 20.19+ or 22.12+
- Rust 1.90+ toolchain and the platform-specific Tauri prerequisites: <https://tauri.app/start/prerequisites/>

## Development

```sh
npm install
npm run tauri dev
```

To run the frontend in a browser for UI development only:

```sh
npm run dev
```

Browser preview data is saved in that browser's local storage; offline PDF downloads are available in the packaged Tauri desktop app. Use the download icon on a publication tile or row to save it. The desktop app keeps its catalog in SQLite and downloaded PDFs in the app-local data directory. The reader automatically uses a saved copy, and removing that copy does not remove the Archive.org publication from your catalog.

## Archive.org metadata

The app reads `https://archive.org/metadata/{identifier}` and stores the original item metadata as JSON alongside editable catalog fields. Common fields mapped into the form are `title`, `date`, `publisher`, `creator`, `description`/`summary`, `language`, `rights`, and `subject`. Publication dates remain text to accommodate Archive.org's mixed date formats. Archive.org's own `collection` field is kept in the source metadata and is not treated as an app collection.
