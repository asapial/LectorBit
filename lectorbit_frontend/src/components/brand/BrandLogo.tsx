import type { SVGProps } from 'react';
import { cn } from '../../lib/cn';

/**
 * Canonical LectorBit mark.
 *
 * The open L is a lecture frame, the triangle is the current learning moment,
 * and the three tiles turn the playback timeline into durable knowledge bits.
 */
export function BrandLogo({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 512 512"
      className={cn('shrink-0', className)}
      {...props}
    >
      <rect width="512" height="512" rx="112" fill="#A92D12" />
      <path d="M304 0h96c62 0 112 50 112 112v152L304 0Z" fill="#E8491D" />
      <path
        d="M143 119v232c0 20 16 36 36 36h73"
        fill="none"
        stroke="#FFF"
        strokeWidth="52"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m249 150 116 70c16 10 16 33 0 43l-116 70c-17 10-38-2-38-22V172c0-20 21-32 38-22Z"
        fill="#FFF"
      />
      <rect x="280" y="360" width="47" height="47" rx="13" fill="#FFC5A6" />
      <rect x="342" y="360" width="47" height="47" rx="13" fill="#FFF3EC" />
      <rect x="404" y="360" width="47" height="47" rx="13" fill="#FF9C6B" />
    </svg>
  );
}
