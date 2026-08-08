declare module 'lucide-react/dist/esm/icons/*' {
  import type {
    ForwardRefExoticComponent,
    RefAttributes,
    SVGProps,
  } from 'react';

  type LucideIconProps = SVGProps<SVGSVGElement> & {
    size?: string | number;
    absoluteStrokeWidth?: boolean;
  };

  const Icon: ForwardRefExoticComponent<
    Omit<LucideIconProps, 'ref'> & RefAttributes<SVGSVGElement>
  >;
  export default Icon;
}
