import type { SVGProps } from 'react';
import { cn } from '../../lib/cn';

/** Canonical LectorBit mark shared by the desktop chrome and product UI. */
export function BrandLogo({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 512 512"
      className={cn('shrink-0', className)}
      {...props}
    >
      <rect width="512" height="512" rx="112" fill="#C93815" />
      <path
        d="M142 126c0-14 11-25 25-25h29c14 0 25 11 25 25v212h137c14 0 25 11 25 25v24c0 14-11 25-25 25H167c-14 0-25-11-25-25V126Z"
        fill="#FFF"
      />
      <rect x="281" y="101" width="49" height="49" rx="14" fill="#FFC5A6" />
      <rect x="349" y="101" width="49" height="49" rx="14" fill="#FFF3EC" />
    </svg>
  );
}
