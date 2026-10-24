type Child = Node | string | null | undefined | false;

interface ElementProps {
  class?: string;
  title?: string;
  text?: string;
  html?: string;
  type?: string;
  value?: string | number;
  min?: string | number;
  max?: string | number;
  step?: string | number;
  placeholder?: string;
  checked?: boolean;
  disabled?: boolean;
  accept?: string;
  multiple?: boolean;
  id?: string;
  for?: string;
  role?: string;
  dataset?: Record<string, string>;
  aria?: Record<string, string>;
  style?: Partial<CSSStyleDeclaration>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (e: HTMLElementEventMap[K]) => void }>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElementProps = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { class: className, text, html, dataset, aria, style, on, ...rest } = props;

  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (html !== undefined) node.innerHTML = html;

  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined || value === null || value === false) continue;
    if (key in node) (node as unknown as Record<string, unknown>)[key] = value;
    else node.setAttribute(key, String(value));
  }
  if (dataset) for (const [k, v] of Object.entries(dataset)) node.dataset[k] = v;
  if (aria) for (const [k, v] of Object.entries(aria)) node.setAttribute(`aria-${k}`, v);
  if (style) Object.assign(node.style, style);
  if (on) {
    for (const [name, handler] of Object.entries(on)) {
      node.addEventListener(name, handler as EventListener);
    }
  }

  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * Buttons that live on the canvas edge must not steal focus or let a stray
 * drag scroll the page, and on iOS a tap target below 44px is a coin toss.
 */
export function button(
  className: string,
  label: string,
  onPress: () => void,
  children: Child[] = [],
): HTMLButtonElement {
  return el(
    'button',
    {
      class: className,
      type: 'button',
      title: label,
      aria: { label },
      on: {
        click: (e) => {
          e.preventDefault();
          onPress();
        },
      },
    },
    children,
  );
}
