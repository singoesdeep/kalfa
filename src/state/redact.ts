/**
 * Redaction for everything Kalfa writes down.
 *
 * The price of a transparent run is that Kalfa now persists whole subprocess
 * transcripts to disk — builder output, gate stdout, reviewer payloads. Those
 * are exactly the places a token leaks: a test that prints an env var, a curl
 * that echoes an Authorization header, a stack trace carrying a connection
 * string. Artifacts are meant to be read, attached to issues and pasted into
 * chat, so anything Kalfa writes is filtered on the way out.
 *
 * Two sources, both cheap:
 *
 *   - the values of this process's own secret-looking environment variables,
 *     which is what a leaking child most often echoes back
 *   - patterns for the well-known credential shapes, plus whatever the user
 *     configures
 *
 * This is a safety net, not a guarantee, and it is deliberately biased towards
 * over-redacting: a mangled log line costs a minute, a leaked key costs a day.
 */

/** Env var names whose values are assumed to be secret. */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|SESSION)/i;

/** Values too short or too common to redact without wrecking the output. */
const MIN_SECRET_LENGTH = 8;

/** Credential shapes worth catching even when they never touched the env. */
const BUILT_IN_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic style
  /gh[pousr]_[A-Za-z0-9]{16,}/g, // GitHub
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /xox[abposr]-[A-Za-z0-9-]{10,}/g, // Slack
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export interface RedactionResult {
  text: string;
  /** True when anything was replaced — recorded alongside the artifact. */
  redacted: boolean;
}

export class Redactor {
  private readonly literals: Array<{ value: string; label: string }>;
  private readonly patterns: RegExp[];

  /**
   * @param extraPatterns user-configured regular expressions, as source strings
   * @param env the environment to harvest secret values from
   */
  constructor(extraPatterns: string[] = [], env: NodeJS.ProcessEnv = process.env) {
    this.literals = Object.entries(env)
      .filter(([name, value]) => SECRET_NAME.test(name) && (value?.length ?? 0) >= MIN_SECRET_LENGTH)
      .map(([name, value]) => ({ value: value as string, label: name }))
      // Longest first, so a secret that contains another is masked whole.
      .sort((a, b) => b.value.length - a.value.length);

    this.patterns = [...BUILT_IN_PATTERNS];
    for (const source of extraPatterns) {
      try {
        this.patterns.push(new RegExp(source, 'g'));
      } catch {
        // An unusable pattern must not take the run down. It is reported by
        // `kalfa validate`, which is where a config mistake belongs.
      }
    }
  }

  redact(text: string): RedactionResult {
    if (!text) return { text, redacted: false };
    let out = text;

    for (const { value, label } of this.literals) {
      if (!out.includes(value)) continue;
      out = out.split(value).join(`[redacted:${label}]`);
    }
    for (const pattern of this.patterns) {
      pattern.lastIndex = 0;
      out = out.replace(pattern, '[redacted]');
    }

    return { text: out, redacted: out !== text };
  }
}

/** Validate user-supplied patterns without building a Redactor. */
export function invalidPatterns(patterns: string[]): string[] {
  return patterns.filter((source) => {
    try {
      new RegExp(source, 'g');
      return false;
    } catch {
      return true;
    }
  });
}
