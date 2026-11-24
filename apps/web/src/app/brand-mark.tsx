import Image from 'next/image';

export function BrandMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <Image
      className={className}
      src="/icon.svg"
      alt=""
      width={size}
      height={size}
      priority
      unoptimized
    />
  );
}
