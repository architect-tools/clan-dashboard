// Optional local secrets for migration/backup/QA commands. The file is gitignored.
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

if (existsSync('.env.local')) loadEnvFile('.env.local');

export function supabaseServiceHeaders(key) {
  const headers = { apikey: key, 'content-type': 'application/json' };
  // Opaque sb_secret keys belong only in apikey. Legacy service-role JWTs are
  // also valid bearer tokens and still need the Authorization header.
  if (!String(key).startsWith('sb_secret_')) headers.authorization = `Bearer ${key}`;
  return headers;
}
