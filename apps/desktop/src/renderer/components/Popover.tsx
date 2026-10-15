/**
 * The little menu a control opens.
 *
 * One primitive for the conversation menu, the space menu and the composer's
 * `+`, because the hard parts are not the items: the rail is a scroll container,
 * so a menu positioned inside a row would be clipped at the container's edge,
 * and one opened near the bottom would be cut off entirely. `position: fixed`
 * escapes that, at the price of having to decide the place from the trigger's
 * measured rectangle — which is what this does, flipping above the trigger when
 * there is no room below. That flip is the whole reason the composer can use it:
 * the composer sits at the bottom of the window, so its menu always opens
 * upwards, without knowing anything about being at the bottom.
 *
 * It closes on the four things that mean "not this any more": a click outside,
 * Escape, a resize, and a scroll of whatever it is anchored over. The last one is
 * the one that is easy to miss — the menu is anchored to a rectangle that scrolls
 * away beneath it, and a menu left floating over the wrong row is worse than no
 * menu.
 */
import {useEffect, useLayoutEffect, useRef, useState} from 'react';

/** The trigger's place on screen, measured when the menu was opened. */
export interface PopoverAnchor {
  top: number;
  bottom: number;
  left: number;
}

export function Popover({
  anchor,
  label,
  onClose,
  children,
}: {
  anchor: PopoverAnchor;
  /** What the menu is for, for a screen reader. */
  label: string;
  onClose: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState({
    top: anchor.bottom + 4,
    left: anchor.left,
  });

  /*
   * Measured after the first paint and placed before the browser shows it, so
   * the menu never appears in one place and jumps to another.
   */
  useLayoutEffect(() => {
    const menu = root.current;
    if (menu === null) {
      return;
    }
    const rect = menu.getBoundingClientRect();
    const margin = 8;
    const below =
      anchor.bottom + 4 + rect.height + margin <= window.innerHeight;
    const top = below
      ? anchor.bottom + 4
      : Math.max(margin, anchor.top - rect.height - 4);
    const left = Math.max(
      margin,
      Math.min(anchor.left, window.innerWidth - rect.width - margin),
    );
    setPlaced({top, left});
  }, [anchor]);

  useEffect(() => {
    /*
     * On the document rather than on a blur: a click on an item blurs the
     * trigger first, and a blur handler would close the menu before the click
     * could land on what it was aiming at.
     */
    const onPointerDown = (event: MouseEvent): void => {
      if (
        root.current !== null &&
        !root.current.contains(event.target as Node)
      ) {
        onClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    const close = (): void => {
      onClose();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', close);
    // Capture: a nested scroller's event does not bubble to the window.
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [onClose]);

  useEffect(() => {
    // Moved into the menu, so the keyboard is where the menu is.
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, []);

  return (
    <div
      ref={root}
      className="popover"
      role="menu"
      aria-label={label}
      style={{top: `${String(placed.top)}px`, left: `${String(placed.left)}px`}}
    >
      {children}
    </div>
  );
}

/** One item in a rail menu. A button, so the keyboard already knows what to do. */
export function PopoverItem({
  onSelect,
  disabled = false,
  danger = false,
  active = false,
  children,
}: {
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  /**
   * Whether this is the item the keyboard is on.
   *
   * A menu opened by a button does not need this: focus is on the item, and the
   * browser draws that. A menu that opens under a text box does — the composer's
   * `@`, where focus has to stay where the typing is — so the item the next Enter
   * would choose is marked some other way.
   */
  active?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      className={danger ? 'popover-item is-danger' : 'popover-item'}
      data-active={active ? 'true' : undefined}
      disabled={disabled}
      onClick={onSelect}
    >
      {children}
    </button>
  );
}
