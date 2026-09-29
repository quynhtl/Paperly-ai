// The provider registry, kept out of WebAIWorkspace.tsx so that the Sidebar
// header can own the selection without importing a 10k-line component.

declare const Services: {
  cookies: {
    getCookiesFromHost: (host: string, attrs: Record<string, unknown>) => nsICookie[];
  };
  eTLD: { getBaseDomainFromHost: (host: string) => string };
  io: { newURI: (spec: string) => { host: string } };
};

interface nsICookie {
  expiry: number;
  isHttpOnly: boolean;
  isSecure: boolean;
  isSession: boolean;
}

export type WebAIServiceId =
  | "deepseek"
  | "zai"
  | "chatgpt"
  | "claude"
  | "gemini"
  | "notebooklm"
  | "cambridge"
  | "translate"
  | "google";

// "chat" providers take a prompt and stream an answer back, so the composer,
// Capture and the conversation transcript all apply. "lookup" providers are
// ordinary web pages with a search box -- there is no prompt to inject and no
// answer to capture, so the panel hides the chat machinery for them.
export type WebAIServiceKind = "chat" | "lookup";

export interface WebAIService {
  id: WebAIServiceId;
  kind: WebAIServiceKind;
  label: string;
  url: string;
  // lookup providers only: {q} is replaced with the URL-encoded query.
  searchUrlTemplate?: string;
}

export const SERVICES: WebAIService[] = [
  {
    id: "deepseek",
    kind: "chat",
    label: "DeepSeek Web",
    url: "https://chat.deepseek.com/",
  },
  {
    id: "zai",
    kind: "chat",
    label: "Z.ai Web",
    url: "https://chat.z.ai/",
  },
  {
    id: "chatgpt",
    kind: "chat",
    label: "ChatGPT Web",
    url: "https://chatgpt.com/",
  },
  {
    id: "claude",
    kind: "chat",
    label: "Claude Web",
    url: "https://claude.ai/new",
  },
  {
    id: "gemini",
    kind: "chat",
    label: "Gemini Web",
    url: "https://gemini.google.com/app",
  },
  {
    id: "notebooklm",
    kind: "chat",
    label: "NotebookLM",
    url: "https://notebooklm.google.com/",
  },
  {
    id: "cambridge",
    kind: "lookup",
    label: "Cambridge Dictionary",
    url: "https://dictionary.cambridge.org/",
    searchUrlTemplate: "https://dictionary.cambridge.org/dictionary/english/{q}",
  },
  {
    id: "translate",
    kind: "lookup",
    label: "Google Translate",
    // sl=auto rather than sl=en: it still handles English correctly, and a
    // paper quoting French or German does not silently mistranslate.
    url: "https://translate.google.com/",
    searchUrlTemplate:
      "https://translate.google.com/?sl=auto&tl={tl}&text={q}&op=translate",
  },
  {
    id: "google",
    kind: "lookup",
    label: "Google Search",
    url: "https://www.google.com/",
    searchUrlTemplate: "https://www.google.com/search?q={q}",
  },
];

// Target language for Google Translate. Change this line to translate into
// something else; Google Translate also remembers a different target chosen in
// the page itself, which overrides this on later visits.
const TRANSLATION_TARGET = "vi";

/**
 * The provider the panel opens on, and the one "AI Web" falls back to before
 * any chat provider has been used.
 *
 * A named id rather than `SERVICES[0]`: the array is a menu order, and
 * reordering the menu should not silently move the default with it.
 */
export const DEFAULT_SERVICE_ID: WebAIServiceId = "claude";

export function getDefaultService(): WebAIService {
  return (
    SERVICES.find((service) => service.id === DEFAULT_SERVICE_ID) || SERVICES[0]
  );
}

export const isKnownServiceID = (value: unknown): value is WebAIServiceId =>
  typeof value === "string" && SERVICES.some((service) => service.id === value);

export function getServiceByID(serviceID: WebAIServiceId): WebAIService {
  return (
    SERVICES.find((service) => service.id === serviceID) || getDefaultService()
  );
}

export function buildLookupURL(service: WebAIService, query: string): string {
  const trimmed = query.trim();
  if (!service.searchUrlTemplate || !trimmed) {
    return service.url;
  }
  return service.searchUrlTemplate
    .replace("{tl}", TRANSLATION_TARGET)
    .replace("{q}", encodeURIComponent(trimmed));
}

// Counts only cookies that are Secure or HttpOnly -- auth cookies are, analytics
// cookies usually are not -- and unexpired. Checks the registrable base domain
// too, because Google keeps Gemini's and NotebookLM's auth cookies on
// google.com. It cannot tell a live session from a revoked one, and returns true
// when the cookie API throws: a spurious login window is worse than a missing
// one.
export function hasStoredSession(service: WebAIService): boolean {
  try {
    const host = Services.io.newURI(service.url).host;
    const hosts = new Set([host]);
    try {
      hosts.add(Services.eTLD.getBaseDomainFromHost(host));
    } catch {
      // A bare hostname with no registrable domain is fine; fall back to `host`.
    }
    const nowSeconds = Date.now() / 1000;
    return Array.from(hosts).some((candidate) =>
      Services.cookies
        .getCookiesFromHost(candidate, {})
        .some(
          (cookie) =>
            (cookie.isSecure || cookie.isHttpOnly) &&
            (cookie.isSession || cookie.expiry > nowSeconds),
        ),
    );
  } catch {
    return true;
  }
}
