# Magazine Rack

A desktop catalog for organizing and reading PDF publications hosted on Internet Archive.

## Features

- Create collections with descriptions and custom image thumbnails.
- Set a thumbnail by choosing an image file or dropping an HTTPS image from a browser page.
- Import Archive.org metadata from an item page or a direct PDF URL.
- Edit publication details and use a custom JPG, PNG, GIF, or WebP cover image or the built-in fallback artwork.
- Browse the catalog in tile or list view, search, and sort publications.
- Switch between light and dark appearance; the preference is saved on the device.
- Read PDFs in an in-app PDF.js reader and save them to the app's local data directory for offline reading.
- Use the local catalog by default, with optional account sign-in to sync across devices.
- Sign in with Google, Microsoft, or email/password; usernames are profile names, and forgotten passwords can be reset by email.
- Keep synced account catalogs private, with SQLite as a per-account local cache.

## Requirements

- Node.js 20.19+ or 22.12+
- Rust 1.90+ toolchain and the platform-specific Tauri prerequisites: <https://tauri.app/start/prerequisites/>

## Development

```sh
npm install
npm run tauri dev
```

### Configure accounts and cloud sync

Account sign-in uses Supabase Auth and the Supabase database. To enable it:

1. Create a Supabase project and run [`supabase/schema.sql`](supabase/schema.sql) in its SQL Editor. The schema enables row-level security so each account can only access its own catalog.
2. Copy `.env.example` to `.env` and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from the project's API settings. The anon/publishable key is intended for client apps; **never put a service-role key in the desktop app**.
3. In Supabase Auth, enable email/password and configure Google and Azure (Microsoft) OAuth providers with their client IDs/secrets. Set each provider's callback URL to the Supabase callback URL shown in the provider settings.
4. Add `magazinerack://auth/callback` to Supabase's allowed redirect URLs. Configure email confirmation and password recovery emails to use the provided redirect URL. Configure SMTP for production email delivery.
5. Restart `npm run tauri dev` after changing `.env`.

The local library opens by default. Choose **Sign in to sync** when you want to link this device's catalog to an account. The app opens OAuth in the system browser and uses the registered `magazinerack://` deep link to return. Supabase environment values are required for account sync; without them the app remains local-only. Synced account catalogs use separate local databases. The old pre-account catalog is cleared once; the current local catalog is linked to the first account that opts into sync. Catalog metadata and thumbnails sync through Supabase, while downloaded PDFs remain on each device. Signing out returns to the local catalog.

To run the frontend in a browser for UI development only:

```sh
npm run dev
```

Browser preview data is saved in that browser's local storage; offline PDF downloads are available in the packaged Tauri desktop app. Use the download icon on a publication tile or row to save it. The desktop app keeps a per-account catalog cache in SQLite and downloaded PDFs in the app-local data directory. The reader automatically uses a saved copy, and removing that copy does not remove the Archive.org publication from your catalog.

## Archive.org metadata

The app reads `https://archive.org/metadata/{identifier}` and stores the original item metadata as JSON alongside editable catalog fields. Common fields mapped into the form are `title`, `date`, `publisher`, `creator`, `description`/`summary`, `language`, `rights`, and `subject`. Publication dates remain text to accommodate Archive.org's mixed date formats. Archive.org's own `collection` field is kept in the source metadata and is not treated as an app collection.
