import type { SVGProps } from "react";

/**
 * The sidebar icon set, drawn on a 20px grid with square caps and joins so it reads as technical drawing,
 * not as a generic library. Each mark shows what the page is about: a rack for networks, nodes and links for topology.
 */
type P = SVGProps<SVGSVGElement>;
const Base = ({ children, ...p }: P) => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="square" strokeLinejoin="miter" aria-hidden {...p}>
    {children}
  </svg>
);

/** Four tiles, one lifted: the dashboard. */
export const OverviewIcon = (p: P) => (
  <Base {...p}><path d="M3 3h6v6H3zM11 3h6v3h-6zM11 8h6v9h-6zM3 11h6v6H3z" /></Base>
);
/** Stacked rack units. */
export const NetworksIcon = (p: P) => (
  <Base {...p}><path d="M3 4h14v4H3zM3 12h14v4H3zM6 6h.01M6 14h.01M10 8v4" /></Base>
);
/** Three nodes joined by links. */
export const TopologyIcon = (p: P) => (
  <Base {...p}><path d="M10 6v4M10 10l-5 4M10 10l5 4M8 3h4v3H8zM3 14h4v3H3zM13 14h4v3h-4z" /></Base>
);
/** A prompt inside a frame. */
export const AssistantIcon = (p: P) => (
  <Base {...p}><path d="M3 4h14v10H3zM6 8l3 2-3 2M11 12h3M7 17h6" /></Base>
);
/** A config file with a changed line. */
export const ConfigIcon = (p: P) => (
  <Base {...p}><path d="M5 3h7l3 3v11H5zM12 3v3h3M8 9h4M8 12h4M8 15h2" /></Base>
);
/** A pulse trace. */
export const DiagnosticsIcon = (p: P) => (
  <Base {...p}><path d="M2 10h4l2-5 4 10 2-5h4" /></Base>
);
/** A box with a lid: stored copies. */
export const BackupsIcon = (p: P) => (
  <Base {...p}><path d="M3 4h14v4H3zM4 8v9h12V8M8 12h4" /></Base>
);
/** A log with a marker. */
export const ActivityIcon = (p: P) => (
  <Base {...p}><path d="M4 4v13M4 6h12M4 10h9M4 14h6M4 6h.01" /></Base>
);
/** Layers: a service built from parts. */
export const ServicesIcon = (p: P) => (
  <Base {...p}><path d="M10 3l7 3.5-7 3.5-7-3.5zM3 10l7 3.5 7-3.5M3 13.5L10 17l7-3.5" /></Base>
);
export const SettingsIcon = (p: P) => (
  <Base {...p}><path d="M3 6h8M15 6h2M3 14h2M9 14h8M13 4v4h-2M7 12v4H5" /></Base>
);
