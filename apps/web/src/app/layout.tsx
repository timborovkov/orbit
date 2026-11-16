import "./globals.css";

export const metadata = {
  title: "Orbit",
  description: "Control centre for AI representatives",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
