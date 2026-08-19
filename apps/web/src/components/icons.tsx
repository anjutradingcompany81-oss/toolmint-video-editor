// Small hand-rolled icon set (stroke-based, 20x20 viewBox) so the editor
// doesn't need an icon-font/library dependency for a dozen glyphs.
import type { SVGProps } from "react";

function base(props: SVGProps<SVGSVGElement>) {
  return { width: 16, height: 16, viewBox: "0 0 20 20", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, ...props };
}

export function PlayIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M6 4.5v11l9-5.5-9-5.5z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function PauseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <rect x="5.5" y="4.5" width="3" height="11" fill="currentColor" stroke="none" />
      <rect x="11.5" y="4.5" width="3" height="11" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function LockIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <rect x="5" y="9" width="10" height="7" rx="1.5" />
      <path d="M7 9V6.5a3 3 0 0 1 6 0V9" />
    </svg>
  );
}

export function UnlockIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <rect x="5" y="9" width="10" height="7" rx="1.5" />
      <path d="M7 9V6.5a3 3 0 0 1 5.7-1.3" />
    </svg>
  );
}

export function VolumeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M4 8v4h3l4 3.5v-10.5l-4 3.5H4z" />
      <path d="M14 7.5a4 4 0 0 1 0 5" />
    </svg>
  );
}

export function MuteIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M4 8v4h3l4 3.5v-10.5l-4 3.5H4z" />
      <path d="M13.5 8.5l3 3M16.5 8.5l-3 3" />
    </svg>
  );
}

export function TrashIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M4.5 6h11M8 6V4.5h4V6M6 6l.6 9.2a1 1 0 0 0 1 .8h4.8a1 1 0 0 0 1-.8L14 6" />
    </svg>
  );
}

export function ScissorsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <circle cx="6" cy="6" r="2" />
      <circle cx="6" cy="14" r="2" />
      <path d="M7.6 7.2L16 15M7.6 12.8L16 5" />
    </svg>
  );
}

export function PlusIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M10 4.5v11M4.5 10h11" />
    </svg>
  );
}

export function VideoKindIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <rect x="3" y="5.5" width="10" height="9" rx="1.2" />
      <path d="M13 8.5l4-2.3v7.6l-4-2.3" />
    </svg>
  );
}

export function ImageKindIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <rect x="3" y="4" width="14" height="12" rx="1.2" />
      <circle cx="7.3" cy="8" r="1.3" />
      <path d="M3.8 15l4.4-4.6a1 1 0 0 1 1.4 0l1.9 2 2.4-2.6a1 1 0 0 1 1.4 0l1.9 2" />
    </svg>
  );
}

export function AudioKindIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M7 13V5.8l7-1.6v7" />
      <circle cx="5.3" cy="13.5" r="1.8" />
      <circle cx="12.3" cy="11.5" r="1.8" />
    </svg>
  );
}

export function TrackKindIcon({ kind, ...props }: SVGProps<SVGSVGElement> & { kind: "video" | "audio" | "text" }) {
  if (kind === "video") return <VideoKindIcon {...props} />;
  if (kind === "audio") return <AudioKindIcon {...props} />;
  return (
    <svg {...base(props)}>
      <path d="M5 5.5h10M10 5.5v9" />
    </svg>
  );
}
