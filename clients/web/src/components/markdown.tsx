"use client";

import { InlineCode, useFileLink } from "./file-preview/file-path-chip";
import { Fragment, memo, PropsWithChildren, useMemo } from "react";
import ReactMarkdown, { type Components, defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { PreBlock } from "./pre-block";
import { isJson, isString, toAny } from "lib/utils";
import { splitMarkdownBlocks } from "lib/markdown-blocks";
import { isSafeImageSrc, linkifyDataImages } from "lib/chat-ux/inline-images";
import { MarkdownImage } from "./workspace/inline-images";
import JsonView from "ui/json-view";
import { LinkIcon } from "lucide-react";
import { WritingCursor } from "ui/writing-cursor";

/** Placeholder swapped for the live cursor by InlineContent. */
const CURSOR_TOKEN = "[writing-cursor]";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "ui/table";

/**
 * Renders inline content, swapping the streaming cursor placeholder for the
 * real cursor.
 *
 * This replaced a per-word fade-in. That effect wrapped every single word in
 * its own `animate-in duration-1000` span, so a 500-word reply meant 500
 * concurrently animating nodes -- and because the markdown was re-parsed on
 * every token, each new token remounted them and restarted every animation.
 * The result was a message that shimmered continuously and pegged the main
 * thread instead of settling. Entry animation now happens once per *block*
 * (see MarkdownBlock), which is a single node per paragraph rather than one
 * per word.
 */
export const InlineContent = memo(({ children }: PropsWithChildren) => {
  const parts = [children].flat();
  return parts.map((child, index) =>
    isString(child) && child.includes(CURSOR_TOKEN) ? (
      <Fragment key={index}>
        {child.split(CURSOR_TOKEN).map((chunk, i) => (
          <Fragment key={i}>
            {i > 0 && <WritingCursor />}
            {chunk}
          </Fragment>
        ))}
      </Fragment>
    ) : (
      <Fragment key={index}>{child}</Fragment>
    ),
  );
});
InlineContent.displayName = "InlineContent";
function MarkdownLink({ children, href, ...props }: any) {
  const openFile = useFileLink(href);
  return (
    <a
      className="text-primary hover:underline flex gap-1.5 items-center"
      target="_blank"
      rel="noreferrer"
      href={href}
      {...props}
      onClick={
        openFile
          ? (e) => {
              e.preventDefault();
              openFile();
            }
          : undefined
      }
    >
      <LinkIcon className="size-3.5" />
      <InlineContent>{children}</InlineContent>
    </a>
  );
}

const components: Partial<Components> = {
  table: ({ node, children, ...props }) => {
    return (
      <div className="my-2">
        <Table {...props}>{children}</Table>
      </div>
    );
  },
  thead: ({ node, children, ...props }) => {
    return <TableHeader {...props}>{children}</TableHeader>;
  },
  tbody: ({ node, children, ...props }) => {
    return <TableBody {...props}>{children}</TableBody>;
  },
  tr: ({ node, children, ...props }) => {
    return <TableRow {...props}>{children}</TableRow>;
  },
  th: ({ node, children, ...props }) => {
    return (
      <TableHead {...props}>
        <InlineContent>{children}</InlineContent>
      </TableHead>
    );
  },
  td: ({ node, children, ...props }) => {
    return (
      <TableCell {...props}>
        <InlineContent>{children}</InlineContent>
      </TableCell>
    );
  },
  code: ({ children }) => <InlineCode>{children}</InlineCode>,
  blockquote: ({ children }) => {
    return (
      <div className="px-2">
        <blockquote className="relative bg-accent/30 p-3.5 rounded-xl my-2.5 overflow-hidden border">
          <InlineContent>{children}</InlineContent>
        </blockquote>
      </div>
    );
  },
  p: ({ children }) => {
    return (
      <p className="leading-relaxed my-2 first:mt-0 last:mb-0 break-words text-justify [text-align-last:left]">
        <InlineContent>{children}</InlineContent>
      </p>
    );
  },
  pre: ({ children }) => {
    return (
      <div className="py-1.5">
        <PreBlock>{children}</PreBlock>
      </div>
    );
  },
  ol: ({ node, children, ...props }) => {
    return (
      <ol className="px-6 list-decimal list-outside my-2 space-y-0.5" {...props}>
        {children}
      </ol>
    );
  },
  li: ({ node, children, ...props }) => {
    return (
      <li className="py-0.5 break-words text-justify [text-align-last:left]" {...props}>
        <InlineContent>{children}</InlineContent>
      </li>
    );
  },
  ul: ({ node, children, ...props }) => {
    return (
      <ul className="px-6 list-outside list-disc my-2 space-y-0.5" {...props}>
        {children}
      </ul>
    );
  },
  strong: ({ node, children, ...props }) => {
    return (
      <span className="font-semibold" {...props}>
        <InlineContent>{children}</InlineContent>
      </span>
    );
  },
  a: ({ node, children, ...props }) => <MarkdownLink {...toAny(props)}>{children}</MarkdownLink>,
  h1: ({ node, children, ...props }) => {
    return (
      <h1 className="text-2xl font-semibold mt-4 mb-1.5" {...props}>
        <InlineContent>{children}</InlineContent>
      </h1>
    );
  },
  h2: ({ node, children, ...props }) => {
    return (
      <h2 className="text-xl font-semibold mt-3.5 mb-1.5" {...props}>
        <InlineContent>{children}</InlineContent>
      </h2>
    );
  },
  h3: ({ node, children, ...props }) => {
    return (
      <h3 className="text-lg font-semibold mt-3 mb-1" {...props}>
        <InlineContent>{children}</InlineContent>
      </h3>
    );
  },
  h4: ({ node, children, ...props }) => {
    return (
      <h4 className="text-base font-semibold mt-2.5 mb-1" {...props}>
        <InlineContent>{children}</InlineContent>
      </h4>
    );
  },
  h5: ({ node, children, ...props }) => {
    return (
      <h5 className="text-sm font-semibold mt-2 mb-0.5" {...props}>
        <InlineContent>{children}</InlineContent>
      </h5>
    );
  },
  h6: ({ node, children, ...props }) => {
    return (
      <h6 className="text-xs font-semibold mt-2 mb-0.5" {...props}>
        <InlineContent>{children}</InlineContent>
      </h6>
    );
  },
  img: ({ node, children, ...props }) => {
    const { src, alt, ...rest } = props;

    if (typeof src === "string" && isSafeImageSrc(src)) {
      return <MarkdownImage src={src} alt={alt} />;
    }
    return src ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img className="mx-auto rounded-lg" src={src} alt={alt} {...rest} />
    ) : null;
  },
};

/**
 * One top-level markdown block, memoized on its own source.
 *
 * This is the whole point of the block split: while a reply streams, only the
 * final block's source is changing. Every earlier block compares equal, React
 * bails out, and none of the already-rendered text is re-parsed, re-rendered
 * or re-animated. Previously each token re-parsed the entire document.
 */
/**
 * react-markdown's default transform strips every data: URL, which also
 * strips an image a model printed inline. Raster data URLs are let through
 * for image sources only; links and everything else keep the default rules.
 */
function urlTransform(url: string, key: string): string {
  if (key === "src" && isSafeImageSrc(url)) return url;
  return defaultUrlTransform(url);
}

const MarkdownBlock = memo(
  function MarkdownBlock({ source }: { source: string }) {
    return (
      <div className="animate-in fade-in duration-300">
        <ReactMarkdown
          components={components}
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[rehypeKatex]}
          urlTransform={urlTransform}
        >
          {source}
        </ReactMarkdown>
      </div>
    );
  },
  (prev, next) => prev.source === next.source,
);

const NonMemoizedMarkdown = ({
  children,
  isStreaming,
}: {
  children: string;
  isStreaming?: boolean;
}) => {
  const blocks = useMemo(() => splitMarkdownBlocks(children), [children]);

  if (isJson(children)) {
    return (
      <article className="w-full h-full relative">
        <JsonView data={children} />
      </article>
    );
  }

  return (
    <article className="w-full h-full relative">
      {blocks.map((block, index) => {
        const isLast = index === blocks.length - 1;
        // The cursor belongs to the block currently being written, so it
        // travels with the text instead of anchoring to the message end.
        // A block still being written is left raw: half a data URL would
        // flash a broken image on every token until the base64 finishes.
        const source =
          isStreaming && isLast
            ? `${block} ${CURSOR_TOKEN}`
            : linkifyDataImages(block);
        // Keyed by position: a block's index is stable for its lifetime
        // (blocks are only ever appended while streaming), so completed
        // blocks keep their identity and never remount.
        return <MarkdownBlock key={index} source={source} />;
      })}
    </article>
  );
};

export const Markdown = memo(
  NonMemoizedMarkdown,
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    prevProps.isStreaming === nextProps.isStreaming,
);
