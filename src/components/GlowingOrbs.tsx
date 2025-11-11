"use client";

import { motion } from "framer-motion";
import styles from "./GlowingOrbs.module.css";

const orbs = [
  {
    size: 420,
    initial: { x: -180, y: -120 },
    animate: { x: 120, y: 80 },
    duration: 18,
    hue: "var(--orb-blue)",
  },
  {
    size: 360,
    initial: { x: 220, y: -140 },
    animate: { x: -60, y: 160 },
    duration: 24,
    hue: "var(--orb-purple)",
  },
  {
    size: 260,
    initial: { x: -120, y: 180 },
    animate: { x: 200, y: -160 },
    duration: 20,
    hue: "var(--orb-cyan)",
  },
];

export const GlowingOrbs = () => (
  <div className={styles.scene} aria-hidden>
    {orbs.map((orb, index) => (
      <motion.div
        key={index}
        className={styles.orb}
        style={{
          width: orb.size,
          height: orb.size,
          background: orb.hue,
        }}
        initial={orb.initial}
        animate={orb.animate}
        transition={{
          duration: orb.duration,
          repeat: Infinity,
          repeatType: "reverse",
          ease: "easeInOut",
        }}
      />
    ))}
  </div>
);

