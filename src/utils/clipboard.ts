/**
 * Copies text to the system clipboard.
 *
 * `Zotero.Utilities.Internal.copyTextToClipboard` is the right call and is
 * present in every build this fork targets, but it lives behind a chain of
 * optional namespaces; the platform service is the fallback so a missing link
 * in that chain loses a convenience rather than the action.
 */
export function copyTextToClipboard(text: string): void {
  try {
    Zotero.Utilities.Internal.copyTextToClipboard(text);
    return;
  } catch {
    // Fall through to the platform helper.
  }

  const componentClasses = Components.classes as Record<
    string,
    { getService: (interfaceType: unknown) => nsIClipboardHelper }
  >;
  const clipboardHelper = componentClasses[
    "@mozilla.org/widget/clipboardhelper;1"
  ].getService(Components.interfaces.nsIClipboardHelper);
  clipboardHelper.copyString(text);
}
