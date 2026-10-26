# Magazine Rack

A desktop catalog for organizing and reading PDF publications hosted on Internet Archive.

## Features

- Create collections with descriptions and custom image thumbnails.
- Set a thumbnail by choosing an image file or dropping an HTTPS image from a browser page.
- Import Archive.org metadata from an item page or a direct PDF URL.
- Automatically use an Archive.org item's `__ia_thumb.jpg` as its cover when that image exists and is valid.
- Edit publication details and use a custom JPG, PNG, GIF, or WebP cover image or the built-in fallback artwork.
- Browse the catalog in tile or list view, search, and sort publications.
- Switch between light and dark appearance; the preference is saved on the device.
- Read PDFs in an in-app PDF.js reader and save them to the app's local data directory for offline reading.
- Store the complete catalog locally in SQLite. No account, cloud service, or API credentials are required.

## Requirements

- Node.js 20.19+ or 22.12+
- Rust 1.90+ toolchain and the platform-specific Tauri prerequisites: <https://tauri.app/start/prerequisites/>

## Development

```sh
npm install
npm run tauri dev
```

## Build an installable desktop app from GitHub

Magazine Rack is a native Tauri app. Users can build it on their own computer without a cloud project or hosting account.

### Requirements

- Node.js 20.19+ or 22.12+
- Rust 1.90+
- Platform-specific Tauri prerequisites: <https://tauri.app/start/prerequisites/>

### Download the source and build

Either use **Code → Download ZIP** on the GitHub repository and extract it, or clone it (replace `OWNER` with the GitHub account or organization):

```sh
git clone https://github.com/OWNER/MagazineRack.git
cd MagazineRack
npm install
npm run tauri build
```

Build on the operating system you want to use. Tauri places the resulting packages under `src-tauri/target/release/bundle/` (for example, a Windows installer, macOS disk image, or Linux package). No `.env` file or network backend is needed to build or run the local app.

To run the app in development mode instead, use `npm run tauri dev`.

### Data and privacy

Collections, publication metadata, and thumbnails are stored in SQLite on the user's computer. PDFs remain on Archive.org unless the user downloads an offline copy, which is also stored locally. On first launch, any cached account catalog is migrated to the local library and legacy pre-account catalog data is cleared. The app does not send catalog data to a service. Previously stored data in a Supabase project is not deleted automatically; it can be removed separately from that project's dashboard.

To run the frontend in a browser for UI development only:

```sh
npm run dev
```

Browser preview data is saved in that browser's local storage; offline PDF downloads are available in the packaged Tauri desktop app. Use the download icon on a publication tile or row to save a PDF. The reader automatically uses a saved copy, and removing that copy does not remove the Archive.org publication from your catalog.

## Archive.org metadata

The app reads `https://archive.org/metadata/{identifier}` and stores the original item metadata as JSON alongside editable catalog fields. Common fields mapped into the form are `title`, `date`, `publisher`, `creator`, `description`/`summary`, `language`, `rights`, and `subject`. Publication dates remain text to accommodate Archive.org's mixed date formats. Archive.org's own `collection` field is kept in the source metadata and is not treated as an app collection.
