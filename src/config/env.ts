/**
 * Local `.env` loading.
 *
 * Node 22 can read a dotenv file natively, so there is no dependency here. The
 * call is best-effort: a missing file is normal in production, where the
 * environment is supplied by the platform. Nothing about the file's contents is
 * ever logged.
 */

/**
 * Loads `.env` from the process working directory if it exists.
 * Returns whether a file was actually loaded.
 */
export function loadDotEnv(path = ".env"): boolean {
  try {
    process.loadEnvFile(path);
    return true;
  } catch {
    return false;
  }
}
