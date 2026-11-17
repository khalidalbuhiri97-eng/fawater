# Fawater production deployment

Fawater is a single-origin Bun + Express application. Do not deploy the Vite bundle as a static-only site: the API and background queue worker must stay available in a persistent server process.

## Container

The repository includes a Dockerfile. Build and run it with:

```sh
docker build -t fawater .
docker run --rm -p 3000:3000 \
  -e SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY" \
  -e GEMINI_API_KEY="$GEMINI_API_KEY" \
  fawater
```

The public Supabase project URL and publishable key are configured as safe defaults in the app. They can be overridden with `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_ANON_KEY`, `VITE_SUPABASE_URL`, and `VITE_SUPABASE_PUBLISHABLE_KEY`.

## Vercel deployment

The project homepage is configured for Vercel. The repository now includes `vercel.json` and an API catch-all at `api/[...path].ts`; Vercel serves the built Vite frontend and routes `/api/*` requests through the Express API function.

Vercel background invoice processing uses `waitUntil` and chains bounded worker invocations. Each invocation handles up to five AI jobs, claims jobs atomically in Supabase to prevent duplicate Gemini calls, and schedules the next invocation while jobs remain. The worker endpoint is protected by the server-only Supabase service-role key. Invoice files are uploaded directly from the browser to the private Storage bucket, avoiding Vercel's request-body limit.

Set the following as **Vercel Production and Preview environment variables** before relying on AI processing:

- `SUPABASE_SERVICE_ROLE_KEY`
- `GEMINI_API_KEY`

Set `APP_URL` only if it is a full HTTPS URL; otherwise Vercel's `VERCEL_URL` is used automatically for worker chaining. After changing environment variables, redeploy the project so the new function runtime receives them.

## Required server secrets

Set these in the hosting provider's secret/environment-variable manager. Never commit them or put them in a `VITE_*` variable:

- `SUPABASE_SERVICE_ROLE_KEY`: Supabase server secret/service-role key. Required for database writes and private Storage access.
- `GEMINI_API_KEY`: Google Gemini API key. Required for AI extraction.

Optional:
- `PORT`: HTTP port (defaults to 3000).
- `APP_URL`: canonical public app URL.

## Runtime requirements

- Use a persistent container/service, not a static-site deployment or short-lived serverless function.
- Keep at least one server instance running. The in-process worker processes queued invoices sequentially.
- Mount a persistent volume at `/app/server/.queue_data` if available. Supabase remains the durable source for queued jobs and invoice images, so local disk is only a cache.
- Configure the host health check to request `/api/health`.
- Do not scale multiple app instances until database-level worker claiming/coordination is enabled. The current worker is designed for one active server process.
- Configure the host to restart the process after failure; startup recovery requeues pending/interrupted jobs from Supabase.

## Verification

1. Check `GET /api/health`: `geminiConfigured` must be true and the Supabase status must report connected with both Storage buckets ready.
2. Sign in and upload a small invoice image/PDF.
3. Confirm a row appears in `ai_processing_batches` and `ai_processing_jobs`, the image appears in the private `invoice-images` bucket, and the job changes from `pending` to `processing` to `completed`.
4. Confirm extracted invoice data is stored in `invoices` and `ai_processing_jobs.extracted_data`.
5. Restart the server with a pending job and confirm it resumes.

A successful frontend build alone does not verify the runtime secrets, live Gemini API, or background worker.
