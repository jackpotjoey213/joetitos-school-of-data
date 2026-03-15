import { ClerkProvider, SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/nextjs";

export const metadata = {
  title: "Joetito's School of Data",
  description: "AI-powered college basketball predictions",
};

export default function RootLayout({ children }) {
  return (
    <ClerkProvider>
      <html lang="en">
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
          <meta name="apple-mobile-web-app-capable" content="yes" />
          <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
          <meta name="theme-color" content="#0a0a0f" />
          <link rel="manifest" href="/manifest.json" />
          <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@500;600;700;800&display=swap" rel="stylesheet" />
          <style>{`
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body { background: #0a0a0f; font-family: 'Inter', -apple-system, sans-serif; }
            ::-webkit-scrollbar { display: none; }
          `}</style>
        </head>
        <body>
          <SignedOut>
            <div style={{
              minHeight: "100vh", display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center", background: "#0a0a0f",
              color: "#e8e8f0", padding: "20px", textAlign: "center"
            }}>
              <div style={{ fontSize: "48px", marginBottom: "16px" }}>🎓</div>
              <h1 style={{
                fontSize: "28px", fontWeight: 900, marginBottom: "8px",
                background: "linear-gradient(135deg, #6366f1, #a855f7)",
                WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent"
              }}>
                Joetito&apos;s School of Data
              </h1>
              <p style={{ color: "#5a5a78", fontSize: "14px", marginBottom: "32px", maxWidth: "300px" }}>
                AI-powered college basketball predictions with self-learning model
              </p>
              <SignInButton mode="modal">
                <button style={{
                  background: "linear-gradient(135deg, #6366f1, #a855f7)",
                  color: "#fff", border: "none", borderRadius: "12px",
                  padding: "14px 32px", fontSize: "16px", fontWeight: 700,
                  cursor: "pointer", letterSpacing: "0.3px"
                }}>
                  Sign In to Continue
                </button>
              </SignInButton>
              <p style={{ color: "#3a3a58", fontSize: "11px", marginTop: "16px" }}>
                Google sign-in or email + password
              </p>
            </div>
          </SignedOut>
          <SignedIn>
            {children}
          </SignedIn>
        </body>
      </html>
    </ClerkProvider>
  );
}
