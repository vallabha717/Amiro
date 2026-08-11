"use client";

import { motion } from "framer-motion";
import { VrndaLogo } from "@/components/layouts/vrnda-logo";

export function WritingCursor() {
  return (
    <span className="inline-block relative ml-1 select-none pointer-events-none align-baseline">
      {/* Magical writing sparkles from the leaf tip */}
      <motion.span
        className="absolute -left-1 bottom-1 size-1 bg-primary/80 rounded-full blur-[0.5px]"
        animate={{
          scale: [1, 2, 0.5],
          opacity: [0.8, 1, 0],
          y: [0, 4, 8],
          x: [0, -2, -4],
        }}
        transition={{
          duration: 0.6,
          repeat: Infinity,
          ease: "easeOut",
        }}
      />
      <motion.span
        className="absolute -left-1 bottom-1 size-1 bg-teal-300 rounded-full blur-[0.5px]"
        animate={{
          scale: [0.8, 1.6, 0.4],
          opacity: [0.6, 0.9, 0],
          y: [0, 3, 6],
          x: [0, -1.5, -3],
        }}
        transition={{
          duration: 0.7,
          repeat: Infinity,
          delay: 0.2,
          ease: "easeOut",
        }}
      />

      {/* Tilted, wiggling Leaf Logo acting as a pen */}
      <motion.div
        className="origin-bottom-left text-primary fill-current"
        animate={{
          rotate: [0, -8, 6, 0],
          x: [0, 2, -1, 0],
          y: [0, -1, 2, 0],
        }}
        transition={{
          duration: 0.6,
          repeat: Infinity,
          ease: "easeInOut",
        }}
        style={{
          transform: "translateY(4px) rotate(-30deg)",
        }}
      >
        <VrndaLogo className="size-5" />
      </motion.div>
    </span>
  );
}
