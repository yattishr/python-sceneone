import { CopilotKit } from "@copilotkit/react-core";
import "@copilotkit/react-ui/styles.css"
import type { Metadata } from "next";
import { Geist_Mono, Orbitron, Space_Grotesk } from "next/font/google";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
});

const orbitron = Orbitron({
  variable: "--font-orbitron",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SceneOne Studio",
  description: "Generative broadcast suite for live ad direction",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${spaceGrotesk.variable} ${orbitron.variable} ${geistMono.variable}`}>
        <CopilotKit runtimeUrl="/api/copilotkit" agent="adk_agent">
          {children}
        </CopilotKit>
      </body>
    </html>
  );
}
