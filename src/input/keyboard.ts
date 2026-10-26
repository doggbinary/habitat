import { flipStampH, flipStampV, rotateStampCW } from '../core/stamp';
import type { Store } from '../core/store';
import { stepZoom, zoomAt } from '../render/camera';
import type { Renderer } from '../render/renderer';
import type { Shell } from '../ui/shell';
import type { PointerInput } from './pointer-input';

/**
 * Shortcuts for a Magic Keyboard or a desktop browser. Everything here has a
 * touch equivalent, so the app is complete without a keyboard attached.
 *
 * Undo, redo and the tool keys are routed through the shell, because what
 * they should do depends on whether the map or the character studio is open.
 */
export function bindKeyboard(options: {
  store: Store;
  renderer: Renderer;
  input: PointerInput;
  shell: Shell;
  fitToView: () => void;
}): void {
  const { store, renderer, input, shell } = options;

  const typing = (target: EventTarget | null): boolean => {
    const node = target as HTMLElement | null;
    if (!node) return false;
    return (
      node.isContentEditable ||
      node.tagName === 'INPUT' ||
      node.tagName === 'TEXTAREA' ||
      node.tagName === 'SELECT'
    );
  };

  window.addEventListener('keydown', (e) => {
    if (typing(e.target)) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();

    if (mod && key === 'z') {
      e.preventDefault();
      if (e.shiftKey) shell.redo();
      else shell.undo();
      return;
    }
    if (mod && key === 'y') {
      e.preventDefault();
      shell.redo();
      return;
    }
    if (mod) return;

    if (key === ' ') {
      e.preventDefault();
      input.setSpaceHeld(true);
      return;
    }

    if (key === 'escape' && shell.putAway()) {
      e.preventDefault();
      return;
    }

    if ((key === 'delete' || key === 'backspace') && shell.deleteSelected()) {
      e.preventDefault();
      return;
    }

    if (shell.selectToolByKey(key)) {
      e.preventDefault();
      return;
    }

    switch (key) {
      case 'x':
        store.setStamp(flipStampH(store.stamp), store.paletteSelection);
        break;
      case 'y':
        store.setStamp(flipStampV(store.stamp), store.paletteSelection);
        break;
      case 'q':
        store.setStamp(rotateStampCW(store.stamp), store.paletteSelection);
        break;
      case '[':
      case ']':
        store.settings.brushSize = Math.max(1, Math.min(8, store.settings.brushSize + (key === ']' ? 1 : -1)));
        store.emit('ui');
        renderer.requestDraw();
        break;
      case 'f':
        store.settings.showGrid = !store.settings.showGrid;
        store.emit('ui');
        store.emit('doc');
        break;
      case '0':
        options.fitToView();
        break;
      case '=':
      case '+':
      case '-':
      case '_': {
        const direction = key === '-' || key === '_' ? -1 : 1;
        zoomAt(store.camera, renderer.viewW / 2, renderer.viewH / 2, stepZoom(store.camera.zoom, direction));
        store.emit('view');
        renderer.requestDraw();
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  });

  window.addEventListener('keyup', (e) => {
    if (e.key === ' ') input.setSpaceHeld(false);
  });

  // A dropped Space (window blur while held) would otherwise leave the editor
  // stuck in pan mode.
  window.addEventListener('blur', () => input.setSpaceHeld(false));
}
