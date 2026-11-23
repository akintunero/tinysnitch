import type { Metadata } from "next";
import { cookies } from "next/headers";
import { AppShell } from "@/components/layout/app-shell";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tiny Snitch",
  description: "Know your network. Configure it. Fix it.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The chosen theme is a cookie, read here, so the first paint is already right and no script has to run to fix it.
  // No cookie means "follow the system", which the stylesheet handles on its own.
  const theme = (await cookies()).get("ts_theme")?.value;
  return (
    <html lang="en" data-theme={theme === "light" || theme === "dark" ? theme : undefined} suppressHydrationWarning>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
