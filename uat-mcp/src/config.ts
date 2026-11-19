export interface Config {
  /** UAT Tracker origin, without a trailing slash, e.g. https://uat.example.com */
  baseUrl: string;
  /** Tester passphrase. The admin passphrase is never needed by this read-only server. */
  passphrase: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /** Screenshots larger than this are listed but not returned inline. */
  maxImageBytes: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface EnvFile {
  /** UAT_* settings found in the file. */
  vars: Record<string, string>;
  /** Other keys present in the file, which are deliberately not read. */
  ignored: string[];
  found: boolean;
}

/**
 * Reads an optional KEY=VALUE file. Only UAT_* keys are used, so pointing it at a
 * file that also holds database URLs or admin passwords never hands those to the server.
 */
export function parseEnvFile(content: string): Omit<EnvFile, "found"> {
  const vars: Record<string, string> = {};
  const ignored: string[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let value = m[2]!.trim();
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2]!;
    else value = value.replace(/\s+#.*$/, ""); // trailing comment on an unquoted value
    if (key.startsWith("UAT_")) vars[key] = value;
    else ignored.push(key);
  }
  return { vars, ignored };
}

function intSetting(
  raw: string | undefined, fallback: number, min: number, max: number, name: string, problems: string[],
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`${name} must be a whole number between ${min} and ${max} (got "${raw}").`);
    return fallback;
  }
  return n;
}

/** Reads and validates configuration from environment variables. Throws ConfigError listing every problem. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const problems: string[] = [];

  const rawUrl = (env.UAT_BASE_URL ?? "").trim();
  let baseUrl = "";
  if (!rawUrl) {
    problems.push("UAT_BASE_URL is not set (e.g. https://your-uat-app.vercel.app).");
  } else {
    try {
      const u = new URL(rawUrl);
      const isLocal = LOCAL_HOSTS.has(u.hostname);
      if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocal)) {
        problems.push("UAT_BASE_URL must use https:// (plain http is only allowed for localhost) so the passphrase is never sent unencrypted.");
      }
      baseUrl = u.origin + u.pathname.replace(/\/+$/, "");
    } catch {
      problems.push(`UAT_BASE_URL is not a valid URL: "${rawUrl}".`);
    }
  }

  const passphrase = env.UAT_PASSPHRASE ?? "";
  if (!passphrase) {
    problems.push("UAT_PASSPHRASE is not set. Use the tester passphrase; the admin passphrase is not needed.");
  }

  const timeoutMs = intSetting(env.UAT_TIMEOUT_MS, 15_000, 1_000, 120_000, "UAT_TIMEOUT_MS", problems);
  const maxImageBytes = intSetting(env.UAT_MAX_IMAGE_BYTES, 1_500_000, 10_000, 10_000_000, "UAT_MAX_IMAGE_BYTES", problems);

  if (problems.length) throw new ConfigError(problems.join("\n"));
  return { baseUrl, passphrase, timeoutMs, maxImageBytes };
}
