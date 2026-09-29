import { createHostCustomEvent } from "./domEvents";

type EventBusWindowLike = {
  __aiAssistantEventBus?: EventTarget;
};

export function createWindowEventDispatcher<
  TWindow extends EventBusWindowLike,
  TDetail = unknown,
>(eventName: string) {
  const windows = new Set<TWindow>();

  return {
    addWindow(win: TWindow) {
      windows.add(win);
    },
    removeWindow(win: TWindow) {
      windows.delete(win);
    },
    clear() {
      windows.clear();
    },
    dispatch(detail: TDetail) {
      for (const win of windows) {
        const eventBus = win.__aiAssistantEventBus;
        if (!eventBus) continue;
        // Bare `new CustomEvent` throws in Zotero's plugin sandbox, where the
        // constructor is not a global; take it from the host window instead.
        eventBus.dispatchEvent(
          createHostCustomEvent(eventName, detail, win as unknown as Window),
        );
      }
    },
  };
}
