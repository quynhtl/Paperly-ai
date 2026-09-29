// The look-up the column has been asked for but has not picked up yet.
//
// Pressing Translate, Dictionary or Google in the reader's selection popup
// opens the WebAI column and then asks it, over the event bus, to switch to
// that service. When the column was CLOSED, the asking happens before the
// Sidebar has mounted and subscribed: measured, `openWebAIColumn` resolves and
// the event goes out 45ms before the listener exists, because React renders on
// its own schedule and `root.render` does not wait for the effect to run. The
// request was simply lost, and the column opened on whatever provider it had
// been left on -- which looked like the button doing the wrong thing.
//
// So the request is left here as well as dispatched, and the Sidebar takes it
// on the way in. One slot: only the most recent press matters, and whoever
// handles it clears it so it is never replayed.
import type { WebAIServiceId } from "../ui/webAIServices";

export interface LookupRequest {
  serviceID: WebAIServiceId;
  text: string;
}

let pending: LookupRequest | null = null;

export function rememberLookupRequest(request: LookupRequest): void {
  pending = request;
}

/** The request nobody has handled yet. Cleared as it is handed over. */
export function takeLookupRequest(): LookupRequest | null {
  const request = pending;
  pending = null;
  return request;
}
