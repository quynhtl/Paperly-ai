// The three globals React DOM reads straight off the global scope.
//
// A bootstrap plugin's global is a sandbox, not a window, so `window`,
// `document` and `navigator` are simply not there. React DOM does not ask for
// them through the node it is rendering into: `getCurrentEventPriority` reads
// the bare global `window` to look at `window.event`, and a plugin that has
// never bound one gets `ReferenceError: window is not defined` the first time
// it renders -- thrown from inside a DOM event listener, where it is swallowed
// and nothing downstream of the render ever runs.
//
// That was a real bug, not a theoretical one: the look-up row in the reader's
// selection popup went missing until something else had happened to bind these,
// which is why it only appeared after the WebAI column had been opened once.
//
// Anything about to render React must call this first. It is idempotent and it
// never overwrites a global that is already there.

export function bindReactDomGlobals(win: Window | null | undefined): void {
  if (!win) {
    return;
  }
  const scope = globalThis as typeof globalThis & {
    document?: Document;
    navigator?: Navigator;
    window?: Window;
  };
  if (!scope.window) {
    scope.window = win;
  }
  if (!scope.document) {
    scope.document = win.document;
  }
  if (!scope.navigator && "navigator" in win) {
    scope.navigator = win.navigator;
  }
}
