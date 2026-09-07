/**
 * Local-endpoint classification for the Ollama adapter (Phase 2, Milestone 4).
 *
 * Ollama is a **local** model runtime. Its endpoint is configurable — a
 * different port, a different loopback form, a second machine on the same
 * private network — but it must never resolve to a public host: a mistyped
 * or hostile `baseUrl` would otherwise ship the user's whole conversation to
 * a cloud service while the interface still labels the provider "local".
 * `main/ollama-provider.ts` refuses to send anywhere this function rejects.
 *
 * What counts as local here is deliberately decidable **statically, without
 * DNS**, because a resolver answer is exactly the thing an attacker or a
 * typo controls:
 *
 *  - `localhost` and any `*.localhost` name (reserved for loopback by
 *    RFC 6761), matched case-insensitively;
 *  - a literal IPv4 loopback address (`127.0.0.0/8`);
 *  - a literal IPv4 private address (`10/8`, `172.16/12`, `192.168/16`) or
 *    link-local address (`169.254/16`), so an Ollama host on the user's own
 *    LAN stays usable;
 *  - the literal IPv6 loopback (`[::1]`), unique-local (`fc00::/7`) and
 *    link-local (`fe80::/10`) forms.
 *
 * Every other hostname is rejected, **including a hostname that would
 * resolve to a private address**. That is the deliberate trade: a name
 * cannot be checked without asking a resolver, so names other than
 * `localhost` are simply not accepted, and the user configures an address
 * instead. Rejecting something legitimate is recoverable; silently
 * uploading a conversation is not.
 *
 * Pure: no I/O, no DNS, no network. Safe to import from any process — the
 * WHATWG `URL` parser is the only thing it uses, exactly as
 * `settings.schema.ts` already does.
 */

/** Matches a dotted-quad IPv4 literal and captures its four octets. */
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function parseIpv4Octets(hostname: string): number[] | null {
  const match = IPV4_PATTERN.exec(hostname);
  if (match === null) return null;

  const octets = match.slice(1).map((part) => Number.parseInt(part, 10));
  if (octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  return octets;
}

function isLocalIpv4(hostname: string): boolean {
  const octets = parseIpv4Octets(hostname);
  if (octets === null) return false;

  const [first = -1, second = -1] = octets;

  // 127.0.0.0/8 — loopback.
  if (first === 127) return true;
  // 10.0.0.0/8 — private.
  if (first === 10) return true;
  // 172.16.0.0/12 — private.
  if (first === 172 && second >= 16 && second <= 31) return true;
  // 192.168.0.0/16 — private.
  if (first === 192 && second === 168) return true;
  // 169.254.0.0/16 — link-local.
  if (first === 169 && second === 254) return true;

  return false;
}

/**
 * `URL.hostname` returns an IPv6 literal wrapped in brackets and already
 * lowercased and canonicalised, so this only has to classify the prefix.
 */
function isLocalIpv6(hostname: string): boolean {
  if (!hostname.startsWith('[') || !hostname.endsWith(']')) return false;
  const address = hostname.slice(1, -1);

  // ::1 — loopback.
  if (address === '::1') return true;

  // fc00::/7 — unique local. fe80::/10 — link local.
  const firstGroup = address.split(':')[0] ?? '';
  if (firstGroup.length === 0) return false;
  const leading = Number.parseInt(firstGroup, 16);
  if (Number.isNaN(leading)) return false;

  if (firstGroup.length === 4) {
    // fc00::/7 covers fc00–fdff; fe80::/10 covers fe80–febf.
    if (leading >= 0xfc00 && leading <= 0xfdff) return true;
    if (leading >= 0xfe80 && leading <= 0xfebf) return true;
  }

  return false;
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true;
  if (isLocalIpv4(normalized)) return true;
  if (isLocalIpv6(normalized)) return true;
  return false;
}

/**
 * Whether `value` is an absolute `http`/`https` URL whose host is local by
 * the rules in this module's doc comment.
 *
 * Returns `false` — never throws — for an unparsable value, a non-http
 * scheme, an empty string, or a URL carrying embedded credentials (which
 * `settingsSchema` already rejects at the boundary; re-checked here so this
 * function is safe to call on any string, not only one that survived that
 * schema).
 */
export function isLocalHttpEndpoint(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;

  return isLocalHostname(parsed.hostname);
}
