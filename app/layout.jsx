import "../src/styles.css";

export const metadata = {
  title: "CheckVar 2.0 — Check before you transfer",
  description: "Campaign-level scam intelligence for customers and banks.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
