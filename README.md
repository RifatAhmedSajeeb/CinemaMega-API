# CineMega Cloudflare Worker

This is a Cloudflare Workers adaptation of the supplied Supabase Edge Function.

## Setup

1. Install Node.js 20+.
2. In this directory run:

   ```bash
   npm install
   ```

3. Add your Supabase credentials as Worker secrets:

   ```bash
   npx wrangler secret put SUPABASE_URL
   npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
   ```

   Optional but strongly recommended:

   ```bash
   npx wrangler secret put SESSION_SECRET
   ```

   Use a long random secret for `SESSION_SECRET`. Do not expose the service-role key in frontend code.

4. Start locally:

   ```bash
   npm run dev
   ```

5. Deploy:

   ```bash
   npm run deploy
   ```

## Important notes

- The original API routes, Supabase tables, authentication logic, MEGA inspection, byte-range streaming, and database block cache have been retained.
- The Deno entry point was changed to the Cloudflare Workers `export default { fetch(request, env) }` interface.
- Deno `npm:` imports were changed to normal npm package imports.
- The Worker uses `nodejs_compat` for `node:crypto`, `node:buffer`, and Node-compatible APIs used by `megajs`.
- Cloudflare Workers are not a drop-in VPS. The MEGA hashcash proof-of-work, MEGAJS stream implementation, large file streaming, and 2 MB database block cache must be load-tested on the actual Worker plan. Cloudflare CPU, memory, subrequest, and response-duration limits may require moving MEGA resolution/decryption to a Durable Object or external service.
- `?transcode=1` remains unsupported, as it was in the supplied Edge Function.
- The supplied code's default admin credentials (`admin` / `admin123`) are retained for schema compatibility. Immediately log in and change the password, or change the initial admin configuration before public deployment.
- This conversion has not been deployed against your Cloudflare account or tested against your Supabase project. Run `npm run dev` and test `/api/health`, login, catalog, MEGA inspect, and range streaming before production.

## Existing Supabase tables

The code expects the same tables and columns as the original function, including `admin_config`, `library_meta`, `library_folders`, `analytics_state`, `stream_blocks`, `mega_node_keys`, `mega_storage_tickets`, `inspect_cache`, `video_thumbnails`, `viewer_watch_states`, and `played_videos`.
