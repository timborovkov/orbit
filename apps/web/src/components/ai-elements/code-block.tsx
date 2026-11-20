'use client';

import { type HTMLAttributes, useEffect, useState } from 'react';

import type { BundledLanguage } from 'shiki';

import { highlightCode } from '@/components/ai-elements/code-block-highlight';
import { cn } from '@/lib/utils';

type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string;
  language: BundledLanguage;
  showLineNumbers?: boolean;
};

export const CodeBlock = ({
  code,
  language,
  showLineNumbers = false,
  className,
  ...props
}: CodeBlockProps) => {
  const [html, setHtml] = useState<string>('');
  const [darkHtml, setDarkHtml] = useState<string>('');

  useEffect(() => {
    let current = true;
    void highlightCode(code, language, showLineNumbers).then(([light, dark]) => {
      if (current) {
        setHtml(light);
        setDarkHtml(dark);
      }
    });

    return () => {
      current = false;
    };
  }, [code, language, showLineNumbers]);

  return (
    <div
      className={cn(
        'group relative w-full overflow-hidden rounded-md border bg-background text-foreground',
        className,
      )}
      {...props}
    >
      <div className="relative">
        <div
          className="overflow-auto dark:hidden [&>pre]:m-0 [&>pre]:bg-background! [&>pre]:p-4 [&>pre]:text-foreground! [&>pre]:text-sm [&_code]:font-mono [&_code]:text-sm"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: "this is needed."
          dangerouslySetInnerHTML={{ __html: html }}
        />
        <div
          className="hidden overflow-auto dark:block [&>pre]:m-0 [&>pre]:bg-background! [&>pre]:p-4 [&>pre]:text-foreground! [&>pre]:text-sm [&_code]:font-mono [&_code]:text-sm"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: "this is needed."
          dangerouslySetInnerHTML={{ __html: darkHtml }}
        />
      </div>
    </div>
  );
};
