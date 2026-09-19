import type { SVGProps } from "react";

/**
 * One hand-drawn set: 16px grid, 1.5 stroke, round caps. Every icon is
 * decorative (aria-hidden); the control or text next to it carries the name.
 */
type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      {children}
    </svg>
  );
}

export const Mark = ({ size = 20, ...rest }: P) => (
  <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false" {...rest}>
    <path d="M9 9 23 23M23 9 9 23" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" />
    <circle cx="9" cy="9" r="2.9" fill="currentColor" />
    <circle cx="23" cy="9" r="2.9" fill="currentColor" />
    <circle cx="9" cy="23" r="2.9" fill="currentColor" />
    <circle cx="23" cy="23" r="2.9" fill="currentColor" />
    <circle cx="16" cy="3.4" r="1.9" fill="currentColor" />
    <circle cx="16" cy="28.6" r="1.9" fill="currentColor" />
    <circle cx="3.4" cy="16" r="1.9" fill="currentColor" />
    <circle cx="28.6" cy="16" r="1.9" fill="currentColor" />
  </svg>
);

export const Lock = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="7" width="10" height="7" rx="1.5" />
    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
  </Svg>
);
export const Unlock = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="7" width="10" height="7" rx="1.5" />
    <path d="M5.5 7V5a2.5 2.5 0 0 1 4.9-.7" />
  </Svg>
);
export const Ban = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="m4.2 4.2 7.6 7.6" />
  </Svg>
);
export const Shield = (p: P) => (
  <Svg {...p}>
    <path d="M8 1.8 13 3.6v4c0 3.1-2.1 5.4-5 6.6-2.9-1.2-5-3.5-5-6.6v-4L8 1.8Z" />
    <path d="m5.8 8 1.5 1.5 2.9-3" />
  </Svg>
);
export const ShieldOff = (p: P) => (
  <Svg {...p}>
    <path d="M8 1.8 13 3.6v4c0 3.1-2.1 5.4-5 6.6-2.9-1.2-5-3.5-5-6.6v-4L8 1.8Z" />
    <path d="m6 6 4 4m0-4-4 4" />
  </Svg>
);
export const Hourglass = (p: P) => (
  <Svg {...p}>
    <path d="M4.5 2h7M4.5 14h7M5 2c0 3 6 3.5 6 6s-6 3-6 6M11 2c0 3-6 3.5-6 6s6 3 6 6" />
  </Svg>
);
export const Bolt = (p: P) => (
  <Svg {...p}>
    <path d="M9 1.8 3.5 9H8l-1 5.2L12.5 7H8l1-5.2Z" />
  </Svg>
);
export const File = (p: P) => (
  <Svg {...p}>
    <path d="M9 1.8H4.5A1.5 1.5 0 0 0 3 3.3v9.4a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5V5.8L9 1.8Z" />
    <path d="M9 1.8v4h4" />
  </Svg>
);
export const Braces = (p: P) => (
  <Svg {...p}>
    <path d="M5.5 2.5c-1.5 0-2 .6-2 2v1.6c0 .9-.5 1.4-1.3 1.9.8.5 1.3 1 1.3 1.9v1.6c0 1.4.5 2 2 2M10.5 2.5c1.5 0 2 .6 2 2v1.6c0 .9.5 1.4 1.3 1.9-.8.5-1.3 1-1.3 1.9v1.6c0 1.4-.5 2-2 2" />
  </Svg>
);
export const Chevron = (p: P) => (
  <Svg {...p}>
    <path d="m6 4 4 4-4 4" />
  </Svg>
);
export const Laptop = (p: P) => (
  <Svg {...p}>
    <rect x="2.8" y="3" width="10.4" height="7.5" rx="1.2" />
    <path d="M1.5 13h13" />
  </Svg>
);
export const Bot = (p: P) => (
  <Svg {...p}>
    <rect x="2.5" y="5" width="11" height="8.5" rx="2" />
    <path d="M8 2.2V5M6 9h.01M10 9h.01" />
  </Svg>
);
export const Join = (p: P) => (
  <Svg {...p}>
    <path d="M6.5 3H4a1.5 1.5 0 0 0-1.5 1.5v7A1.5 1.5 0 0 0 4 13h2.5M9.5 5.5 12 8l-2.5 2.5M12 8H6" />
  </Svg>
);
export const Leave = (p: P) => (
  <Svg {...p}>
    <path d="M9.5 3H12a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 12 13H9.5M6.5 5.5 4 8l2.5 2.5M4 8h6" />
  </Svg>
);
export const Plus = (p: P) => (
  <Svg {...p}>
    <path d="M8 3v10M3 8h10" />
  </Svg>
);
export const Check = (p: P) => (
  <Svg {...p}>
    <path d="m3.2 8.4 3 3L12.8 4.8" />
  </Svg>
);
export const CheckCircle = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.8" />
    <path d="m5.5 8.2 1.8 1.8 3.4-3.6" />
  </Svg>
);
export const Circle = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.8" />
  </Svg>
);
export const HalfCircle = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.8" />
    <path d="M8 2.2v11.6A5.8 5.8 0 0 0 8 2.2Z" fill="currentColor" stroke="none" />
  </Svg>
);
export const Undo = (p: P) => (
  <Svg {...p}>
    <path d="M5.5 4 2.5 7l3 3" />
    <path d="M2.5 7h7a3.5 3.5 0 0 1 0 7H7" />
  </Svg>
);
export const X = (p: P) => (
  <Svg {...p}>
    <path d="m4 4 8 8m0-8-8 8" />
  </Svg>
);
export const Note = (p: P) => (
  <Svg {...p}>
    <path d="M3 3.5A1.5 1.5 0 0 1 4.5 2h7A1.5 1.5 0 0 1 13 3.5V10l-4 4H4.5A1.5 1.5 0 0 1 3 12.5v-9Z" />
    <path d="M13 10H9v4M5.5 5.5h5M5.5 8h3" />
  </Svg>
);
export const Pen = (p: P) => (
  <Svg {...p}>
    <path d="M10.5 2.5 13.5 5.5 6 13H3v-3l7.5-7.5Z" />
  </Svg>
);
export const Pulse = (p: P) => (
  <Svg {...p}>
    <path d="M1.5 8h3l1.5-4 3 8 1.5-4h4" />
  </Svg>
);
export const Copy = (p: P) => (
  <Svg {...p}>
    <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" />
    <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
  </Svg>
);
export const UserPlus = (p: P) => (
  <Svg {...p}>
    <circle cx="6.5" cy="5.5" r="2.6" />
    <path d="M1.8 13.5c.6-2.3 2.4-3.6 4.7-3.6s4.1 1.3 4.7 3.6M12.5 5v4M10.5 7h4" />
  </Svg>
);
export const Sun = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2.8" />
    <path d="M8 1.5v1.3M8 13.2v1.3M1.5 8h1.3M13.2 8h1.3M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9" />
  </Svg>
);
export const Moon = (p: P) => (
  <Svg {...p}>
    <path d="M13 9.6A5.5 5.5 0 1 1 6.4 3a4.3 4.3 0 0 0 6.6 6.6Z" />
  </Svg>
);
export const Monitor = (p: P) => (
  <Svg {...p}>
    <rect x="2" y="2.5" width="12" height="8.5" rx="1.3" />
    <path d="M5.5 14h5M8 11v3" />
  </Svg>
);
export const Refresh = (p: P) => (
  <Svg {...p}>
    <path d="M13 3v3.5H9.5" />
    <path d="M12.6 6.4A5 5 0 1 0 13 9" />
  </Svg>
);
export const Key = (p: P) => (
  <Svg {...p}>
    <circle cx="5" cy="11" r="2.8" />
    <path d="m7 9 6.5-6.5M11 5l1.8 1.8" />
  </Svg>
);
export const Plug = (p: P) => (
  <Svg {...p}>
    <path d="M5.5 1.8v3M10.5 1.8v3M3.5 4.8h9V7a4.5 4.5 0 0 1-9 0V4.8ZM8 11.5v2.7" />
  </Svg>
);
export const Terminal = (p: P) => (
  <Svg {...p}>
    <rect x="1.8" y="2.5" width="12.4" height="11" rx="1.5" />
    <path d="m4.5 6 2 2-2 2M8.5 10.5h3" />
  </Svg>
);
export const Link = (p: P) => (
  <Svg {...p}>
    <path d="M6.8 9.2a2.8 2.8 0 0 0 4 0l2-2a2.8 2.8 0 0 0-4-4l-.6.6M9.2 6.8a2.8 2.8 0 0 0-4 0l-2 2a2.8 2.8 0 0 0 4 4l.6-.6" />
  </Svg>
);
export const Info = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.8" />
    <path d="M8 7.3v3.4M8 5.2h.01" />
  </Svg>
);
