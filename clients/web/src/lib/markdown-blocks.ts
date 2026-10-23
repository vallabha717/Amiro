/**
 * Splits a markdown document into top-level blocks (paragraphs, headings,
 * list runs, fenced code, tables).
 *
 * This exists so a streaming reply can be rendered as a list of independently
 * memoized blocks. Re-parsing and re-rendering the whole document on every
 * token is O(n^2) over a reply's length, and it is what makes a long answer
 * feel like it is grinding as it arrives: with block splitting, a token only
 * ever invalidates the block currently being written, and everything already
 * on screen stays untouched.
 *
 * Blank lines are the separator, except inside a fenced code block where they
 * are content -- splitting there would tear a code fence in half and leave the
 * renderer showing raw backticks mid-stream.
 */
export function splitMarkdownBlocks(markdown: string): string[] {
  if (!markdown) return [];

  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    if (current.length > 0) {
      blocks.push(current.join("\n"));
      current = [];
    }
  };

  for (const line of markdown.split("\n")) {
    const fenceMatch = /^\s{0,3}(```+|~~~+)/.exec(line);

    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (fence === null) {
        // A fence opening starts its own block so the code keeps its own
        // memoized identity rather than being glued to the paragraph above.
        flush();
        fence = marker[0].repeat(3);
        current.push(line);
        continue;
      }
      current.push(line);
      if (line.trimStart().startsWith(fence)) {
        fence = null;
        flush();
      }
      continue;
    }

    if (fence === null && line.trim() === "") {
      flush();
      continue;
    }

    current.push(line);
  }

  flush();
  return blocks;
}
