"use client";

import React, { useRef } from "react";
import { motion, useMotionValue, useReducedMotion, useSpring, useTransform } from "framer-motion";

interface AnimatedAuthTreeProps {
  className?: string;
  imageSrc?: string;
}

export function AnimatedAuthTree({
  className = "",
  imageSrc = "/images__1_-removebg-preview.png",
}: AnimatedAuthTreeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldReduceMotion = useReducedMotion();

  // Mouse parallax motion values (normalized from -1 to 1)
  const mouseX = useMotionValue(0);
  const mouseY = useMotionValue(0);

  // Apple-style soft spring physics
  const springConfig = { stiffness: 45, damping: 20, mass: 0.8 };
  const smoothX = useSpring(mouseX, springConfig);
  const smoothY = useSpring(mouseY, springConfig);

  // Parallax transforms for tree depth
  const treeRotateX = useTransform(smoothY, [-0.5, 0.5], [4, -4]);
  const treeRotateY = useTransform(smoothX, [-0.5, 0.5], [-6, 6]);
  const treeTranslateX = useTransform(smoothX, [-0.5, 0.5], [-12, 12]);
  const treeTranslateY = useTransform(smoothY, [-0.5, 0.5], [-8, 8]);

  // Handle pointer movements for subtle parallax
  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (shouldReduceMotion || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width - 0.5;
    const y = (e.clientY - rect.top) / rect.height - 0.5;
    mouseX.set(x);
    mouseY.set(y);
  };

  const handlePointerLeave = () => {
    mouseX.set(0);
    mouseY.set(0);
  };

  return (
    <div
      ref={containerRef}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      className={`relative w-full h-full flex items-center justify-center select-none ${className}`}
      style={{ perspective: 1000 }}
    >
      {/* Ambient glowing aura behind tree crown */}
      <motion.div
        aria-hidden="true"
        className="pointer-events-none absolute w-[65%] h-[65%] rounded-full bg-primary/10 blur-3xl"
        initial={{ opacity: 0, scale: 0.8 }}
        animate={
          shouldReduceMotion
            ? { opacity: 0.6, scale: 1 }
            : {
                opacity: [0.35, 0.65, 0.4, 0.65, 0.35],
                scale: [0.95, 1.08, 0.98, 1.05, 0.95],
              }
        }
        transition={{
          duration: 10,
          repeat: Infinity,
          ease: "easeInOut",
        }}
      />

      {/* Main Animated Tree Container */}
      <motion.div
        className="relative w-full h-full"
        style={
          shouldReduceMotion
            ? {}
            : {
                rotateX: treeRotateX,
                rotateY: treeRotateY,
                x: treeTranslateX,
                y: treeTranslateY,
                transformStyle: "preserve-3d",
              }
        }
        initial={{ opacity: 0, scale: 0.95, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{
          duration: 0.9,
          ease: [0.23, 1, 0.32, 1],
        }}
      >
        {/* Organic ambient wind & breathing motion */}
        <motion.div
          className="w-full h-full flex items-center justify-center"
          animate={
            shouldReduceMotion
              ? {}
              : {
                  rotate: [-0.5, 0.5, -0.3, 0.4, -0.5],
                  scale: [1, 1.012, 0.996, 1.01, 1],
                  y: [0, -3, 0, -2, 0],
                }
          }
          transition={{
            duration: 11,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        >
          {/* Masked silhouette using theme-aware colors */}
          <div
            className="w-full h-full bg-foreground transition-colors duration-500 opacity-85 hover:opacity-95"
            style={{
              WebkitMaskImage: `url(${imageSrc})`,
              WebkitMaskSize: "contain",
              WebkitMaskRepeat: "no-repeat",
              WebkitMaskPosition: "center",
              maskImage: `url(${imageSrc})`,
              maskSize: "contain",
              maskRepeat: "no-repeat",
              maskPosition: "center",
            }}
          />
        </motion.div>
      </motion.div>
    </div>
  );
}
