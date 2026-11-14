import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const description =
  "Today's Wise mid-market rates for SGD → LKR, SGD → USD and USD → LKR, with forecasts that learn from their own misses and are always shown next to the random walk.";

export const metadata: Metadata = {
  title: "RateCast · SGD → LKR, SGD → USD, USD → LKR",
  description,
  openGraph: { title: "RateCast", description, type: "website" },
  twitter: { card: "summary", title: "RateCast", description },
};

/** Applies a saved theme before first paint (ThemeToggle stores it), so there's no flash of the wrong one. */
const THEME_SCRIPT = `try{var t=localStorage.getItem("theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col overflow-x-hidden">{children}</body>
    </html>
  );
}
