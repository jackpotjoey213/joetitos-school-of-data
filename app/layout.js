export const metadata = {
  title: "Joetito's School of Data",
  description: "AI-powered college basketball predictions",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
        <meta name="theme-color" content="#0a0a0f" />
        <link rel="manifest" href="/manifest.json" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@500;600;700;800&display=swap" rel="stylesheet" />
      </head>
      <body style={{ margin: 0, background: "#0a0a0f" }}>
        {children}
      </body>
    </html>
  );
}
