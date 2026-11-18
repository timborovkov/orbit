import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const buttonVariants = cva('button', {
  variants: {
    variant: {
      default: 'button-primary',
      outline: 'button-outline',
      ghost: 'button-ghost',
      destructive: 'button-destructive',
      secondary: 'button-outline',
    },
    size: {
      default: '',
      sm: 'button-small',
      xs: 'button-small',
      icon: 'button-icon',
      'icon-sm': 'button-icon !size-8 !min-h-8 !min-w-8 !p-0',
      'icon-xs': 'button-icon !size-6 !min-h-6 !min-w-6 !p-0',
    },
  },
  defaultVariants: { variant: 'default', size: 'default' },
});
export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}
