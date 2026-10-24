"use client";

import { motion } from "framer-motion";
import { VrndaLogo } from "@/components/layouts/vrnda-logo";

export const Think = () => {
  // Generate 8 sparkling particles radiating outwards
  const particles = Array.from({ length: 8 });

  return (
    <div className="relative flex items-center justify-start size-12 select-none pointer-events-none ml-2">
      {/* Sparkling particles */}
      {particles.map((_, i) => {
        const angle = (i * 360) / particles.length;
        const randomDelay = Math.random() * 0.4;
        const randomDuration = 1.2 + Math.random() * 0.8;

        return (
          <motion.div
            key={i}
            className="absolute size-1 bg-primary/90 rounded-full blur-[0.5px]"
            initial={{ x: 0, y: 0, opacity: 0, scale: 0 }}
            animate={{
              x: [0, Math.cos((angle * Math.PI) / 180) * 28],
              y: [0, Math.sin((angle * Math.PI) / 180) * 28],
              opacity: [0, 1, 0.7, 0],
              scale: [0, 1.8, 1, 0],
            }}
            transition={{
              duration: randomDuration,
              repeat: Infinity,
              delay: randomDelay,
              ease: "easeOut",
            }}
            style={{
              // Center the particles relative to the leaf logo
              left: "14px",
              top: "14px",
            }}
          />
        );
      })}

      {/* Floating container */}
      <motion.div
        animate={{
          y: [0, -3, 0],
        }}
        transition={{
          duration: 3,
          repeat: Infinity,
          ease: "easeInOut",
        }}
        style={{
          perspective: 600,
        }}
        className="flex items-center justify-center text-primary fill-current w-9 h-9"
      >
        {/* Animated Leaf Logo (Spin fast -> Wait -> Zoom in/out -> Loop) */}
        <motion.div
          animate={{
            rotateY: [0, 1800, 1800, 1800, 1800],
            scale: [1, 1, 1, 1.4, 1],
          }}
          transition={{
            duration: 4.5, // 4.5 seconds for the entire sequence
            repeat: Infinity,
            ease: "easeInOut",
            times: [0, 0.25, 0.5, 0.75, 1], // Map keyframes to 0%, 25%, 50%, 75%, 100%
          }}
          style={{
            transformStyle: "preserve-3d",
          }}
          className="flex items-center justify-center"
        >
          <VrndaLogo className="size-7" />
        </motion.div>
      </motion.div>
    </div>
  );
};
