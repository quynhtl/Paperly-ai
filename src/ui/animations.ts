import { useCallback, useEffect, useRef, useState } from "react";

// ─── Keyframe definitions ───────────────────────────────────────────

export const KEYFRAMES = {
  fadeIn: `
    @keyframes webai-fade-in {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
  `,
  fadeOut: `
    @keyframes webai-fade-out {
      from { opacity: 1; }
      to   { opacity: 0; }
    }
  `,
  slideUp: `
    @keyframes webai-slide-up {
      from { opacity: 0; transform: translateY(8px); }
      to   { opacity: 1; transform: translateY(0); }
    }
  `,
  slideDown: `
    @keyframes webai-slide-down {
      from { opacity: 0; transform: translateY(-8px); }
      to   { opacity: 1; transform: translateY(0); }
    }
  `,
  scaleIn: `
    @keyframes webai-scale-in {
      from { opacity: 0; transform: scale(0.92); }
      to   { opacity: 1; transform: scale(1); }
    }
  `,
  scaleOut: `
    @keyframes webai-scale-out {
      from { opacity: 1; transform: scale(1); }
      to   { opacity: 0; transform: scale(0.92); }
    }
  `,
  collapseExpand: `
    @keyframes webai-expand {
      from { max-height: 0; opacity: 0; }
      to   { max-height: 500px; opacity: 1; }
    }
  `,
  spin: `
    @keyframes webai-spin {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }
  `,
  pulse: `
    @keyframes webai-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
  `,
  shimmer: `
    @keyframes webai-shimmer {
      0%   { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }
  `,
} as const;

// ─── Animation presets ──────────────────────────────────────────────

export const ANIMATION = {
  fadeIn: "webai-fade-in 200ms cubic-bezier(0.4, 0, 0.2, 1) both",
  fadeOut: "webai-fade-out 150ms cubic-bezier(0.4, 0, 0.2, 1) both",
  slideUp: "webai-slide-up 250ms cubic-bezier(0.16, 1, 0.3, 1) both",
  slideDown: "webai-slide-down 250ms cubic-bezier(0.16, 1, 0.3, 1) both",
  scaleIn: "webai-scale-in 200ms cubic-bezier(0.16, 1, 0.3, 1) both",
  scaleOut: "webai-scale-out 150ms cubic-bezier(0.4, 0, 0.2, 1) both",
  expand: "webai-expand 300ms cubic-bezier(0.4, 0, 0.2, 1) both",
  spin: "webai-spin 1s linear infinite",
  pulse: "webai-pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
  shimmer: "webai-shimmer 1.5s ease-in-out infinite",
} as const;

// ─── CSS transition helpers ─────────────────────────────────────────

export const TRANSITION = {
  fast: "all 120ms cubic-bezier(0.4, 0, 0.2, 1)",
  normal: "all 200ms cubic-bezier(0.4, 0, 0.2, 1)",
  slow: "all 350ms cubic-bezier(0.4, 0, 0.2, 1)",
  bounce: "all 300ms cubic-bezier(0.34, 1.56, 0.64, 1)",
  spring: "all 400ms cubic-bezier(0.16, 1, 0.3, 1)",
} as const;

// ─── React hooks ────────────────────────────────────────────────────

/**
 * Provides mount/unmount animation support.
 *
 * Returns `{ mounted, style }`:
 * - `mounted` controls whether the component should be in the DOM.
 * - `style` provides the animation CSS property.
 *
 * @param isVisible - Whether the component should be visible.
 * @param enterAnimation - CSS animation for entering (default: scaleIn).
 * @param exitAnimation - CSS animation for leaving (default: scaleOut).
 * @param exitDuration - Duration in ms to wait before unmounting (default: 150).
 */
export function useAnimatedMount(
  isVisible: boolean,
  enterAnimation: string = ANIMATION.scaleIn,
  exitAnimation: string = ANIMATION.scaleOut,
  exitDuration = 150,
): { mounted: boolean; style: React.CSSProperties } {
  const [mounted, setMounted] = useState(isVisible);
  const [animating, setAnimating] = useState<"enter" | "exit" | null>(null);
  const timerRef = useRef<any>(null);

  useEffect(() => {
    if (timerRef.current != null) {
      (globalThis as any).clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    if (isVisible) {
      setMounted(true);
      setAnimating("enter");
    } else if (mounted) {
      setAnimating("exit");
      timerRef.current = (globalThis as any).setTimeout(() => {
        setMounted(false);
        setAnimating(null);
      }, exitDuration);
    }

    return () => {
      if (timerRef.current != null) {
        (globalThis as any).clearTimeout(timerRef.current);
      }
    };
  }, [isVisible]);

  const style: React.CSSProperties = {
    animation: animating === "enter"
      ? enterAnimation
      : animating === "exit"
        ? exitAnimation
        : undefined,
  };

  return { mounted, style };
}

/**
 * Returns hover state and CSS style for a subtle scale effect.
 *
 * @param scaleFactor - Scale multiplier on hover (default: 1.02).
 */
export function useHoverScale(
  scaleFactor = 1.02,
): {
  isHovered: boolean;
  hoverProps: {
    onMouseEnter: () => void;
    onMouseLeave: () => void;
  };
  style: React.CSSProperties;
} {
  const [isHovered, setIsHovered] = useState(false);

  const hoverProps = {
    onMouseEnter: useCallback(() => setIsHovered(true), []),
    onMouseLeave: useCallback(() => setIsHovered(false), []),
  };

  const style: React.CSSProperties = {
    transform: isHovered ? `scale(${scaleFactor})` : "scale(1)",
    transition: TRANSITION.fast,
  };

  return { isHovered, hoverProps, style };
}

/**
 * Provides a press-down animation effect.
 */
export function usePressEffect(): {
  isPressed: boolean;
  pressProps: {
    onMouseDown: () => void;
    onMouseUp: () => void;
    onMouseLeave: () => void;
  };
  style: React.CSSProperties;
} {
  const [isPressed, setIsPressed] = useState(false);

  const pressProps = {
    onMouseDown: useCallback(() => setIsPressed(true), []),
    onMouseUp: useCallback(() => setIsPressed(false), []),
    onMouseLeave: useCallback(() => setIsPressed(false), []),
  };

  const style: React.CSSProperties = {
    transform: isPressed ? "scale(0.96)" : "scale(1)",
    transition: TRANSITION.fast,
  };

  return { isPressed, pressProps, style };
}

/**
 * Injects keyframe styles into the document if not already present.
 */
export function ensureKeyframesInjected(doc: Document): void {
  const STYLE_ID = "zotero-webai-keyframes";
  if (doc.getElementById(STYLE_ID)) {
    return;
  }

  const styleEl = doc.createElement("style");
  styleEl.id = STYLE_ID;
  styleEl.textContent = Object.values(KEYFRAMES).join("\n");
  const parent = doc.head || doc.documentElement;
  if (parent) {
    parent.appendChild(styleEl);
  }
}
