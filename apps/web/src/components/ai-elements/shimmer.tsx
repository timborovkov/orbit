'use client';

import { memo, useMemo, type CSSProperties, type ElementType, type JSX } from 'react';
import { domAnimation, LazyMotion, m, type HTMLMotionProps } from 'motion/react';

import { cn } from '@/lib/utils';

export interface TextShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
}

const motionComponents = new Map<string, ReturnType<typeof m.create>>();

function getMotionComponent(tag: keyof JSX.IntrinsicElements) {
  const existing = motionComponents.get(tag);
  if (existing) {
    return existing;
  }
  const created = m.create(tag);
  motionComponents.set(tag, created);
  return created;
}

const ShimmerComponent = ({
  children,
  as: Component = 'p',
  className,
  duration = 2,
  spread = 2,
}: TextShimmerProps) => {
  const MotionComponent = getMotionComponent(Component as keyof JSX.IntrinsicElements);

  const dynamicSpread = useMemo(() => children.length * spread, [children, spread]);

  const motionProps = {
    animate: { backgroundPosition: '0% center' as const },
    className: cn(
      'relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent',
      '[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-background),#0000_calc(50%+var(--spread)))] [background-repeat:no-repeat,padding-box]',
      className,
    ),
    initial: { backgroundPosition: '100% center' as const },
    style: {
      '--spread': `${dynamicSpread}px`,
      backgroundImage:
        'var(--bg), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))',
    } as CSSProperties,
    transition: {
      repeat: Number.POSITIVE_INFINITY,
      duration,
      ease: 'linear' as const,
    },
  } satisfies HTMLMotionProps<'div'>;

  return (
    <LazyMotion features={domAnimation} strict>
      <MotionComponent {...motionProps}>{children}</MotionComponent>
    </LazyMotion>
  );
};

export const Shimmer = memo(ShimmerComponent);
