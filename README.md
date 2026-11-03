# JPIA Media — National University Bacolod

Photo-album site that looks exactly like the **JPIA APP INTERFACE BASELINE**. Every icon in the design is a working control (invisible hotspot over the icon); no layout was changed.

## How Cloudinary fits
Cloudinary stores and serves everything that matters:
- **Photos**: uploaded straight from the visitor's browser to Cloudinary (signed by the server), shown and downloaded from Cloudinary's CDN. Nothing is stored on the web host, so the host's upload-size limits can never break an upload.
- **App data** (albums, access keys, change history): one private file in your Cloudinary library (`jpia-media/_data/state.json`).

Cloudinary itself cannot run server code, so the small Node server in this folder (zero dependencies, nothing to `npm install`) must run on a Node host (Render, Railway, Fly.io, a VPS...). It only needs the environment variables below.

## Deploy (about 5 minutes)
1. Cloudinary Dashboard > Settings > API Keys: copy the **API environment variable** (`cloudinary://...`).
2. Put this folder on GitHub and create a **Web Service** on your host (Node 18+, no build step, start command `npm start`).
3. Set environment variables: `CLOUDINARY_URL`, `SESSION_SECRET`, `PRESIDENT_KEY`, `PRESIDENT_NAME` (see `.env.example`).
4. Open the site URL. Anyone with the link can view it at the same time (pages refresh themselves every few seconds).

Run locally: copy `.env.example` to `.env`, fill it in, `npm start`. Try it offline without Cloudinary: `npm run dev` (President key `president-dev`). Tests: `npm test`.

## Who can do what
| | Unsigned (viewer) | JPIA SC | JPIA VP | JPIA President |
|---|---|---|---|---|
| Search albums, view, **download** photos | yes | yes | yes | yes |
| Create / rename / delete / restore albums | - | yes | yes | yes |
| Upload, pin, delete, restore photos | - | yes | yes | yes |
| History + storage page (the "!" icon) | - | yes | yes | yes |
| Access Key page (the "+" icon) | - | - | SC keys only | all keys |
| See the President's key | - | - | - | yes |

Rules are enforced **on the server**, not just hidden in the page. Each door ("JPIA President", "JPIA VP", "JPIA SC") only accepts keys of its own level. Changing or deleting a key signs that person out immediately. Wrong keys are rate-limited. Deleted albums/photos are kept and can be brought back with RESTORE.

## Upload safety
Server-signed direct uploads; image types only (JPG, PNG, GIF, WebP, HEIC, AVIF, BMP, TIFF); oversize photos are auto-compressed in the browser; automatic retries with a fresh signature on network/5xx errors; each upload is verified with Cloudinary before it appears; changes are saved one at a time so two editors never overwrite each other.

## Access keys are encrypted at rest
Keys are encrypted (AES-256-GCM) before being saved to Cloudinary, so someone who only has your Cloudinary login cannot read them. Set `KEY_SECRET` once (any long random text) and never change it. Also turn on two-step verification for the Cloudinary account itself.

## Lost the President key?
Set `RESET_PRESIDENT=1` and a new `PRESIDENT_KEY`, restart once, then remove `RESET_PRESIDENT`.
