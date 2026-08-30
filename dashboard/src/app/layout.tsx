import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "SUDS — Episode Review",
  description: "Label and inspect LeRobot demonstration and rollout episodes.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
