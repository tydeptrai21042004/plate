import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Free API License Plate Reader",
  description: "License plate detection with Roboflow API and OCR with OCR.space API."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
