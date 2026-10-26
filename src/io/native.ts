import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

/**
 * Native bridges, used only when running inside the iOS app.
 *
 * The web build never loads these paths, so the browser version stays exactly
 * as it was. Everything here degrades to the web implementation if a call
 * fails, because an export that silently does nothing is worse than one that
 * falls back to a download.
 */

export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

/**
 * Native-only chrome tweaks. The status bar is drawn over by the app itself,
 * matching the safe-area padding the CSS already applies.
 */
export async function configureNativeShell(): Promise<void> {
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    await StatusBar.setStyle({ style: Style.Dark });
    await StatusBar.setOverlaysWebView({ overlay: true });
  } catch {
    /* status bar control is cosmetic; never block startup on it */
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      // `readAsDataURL` gives `data:<mime>;base64,<payload>`; the plugin wants
      // only the payload.
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Could not read blob'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Writes a file into the app's Documents folder and offers the share sheet.
 *
 * Documents is the right home for exports: with `UIFileSharingEnabled` the
 * folder shows up under "On My iPad > Habitat" in the Files app, so work
 * is reachable without going through the app at all.
 */
export async function saveFileNative(blob: Blob, filename: string): Promise<boolean> {
  try {
    const data = await blobToBase64(blob);
    const written = await Filesystem.writeFile({
      path: filename,
      data,
      directory: Directory.Documents,
      recursive: true,
    });

    try {
      await Share.share({
        title: filename,
        url: written.uri,
        dialogTitle: 'Save or send your export',
      });
    } catch {
      // A dismissed share sheet is fine: the file is already on disk.
    }
    return true;
  } catch {
    return false;
  }
}
