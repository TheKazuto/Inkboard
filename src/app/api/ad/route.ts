/**
 * /api/ad — Serves the Adsterra ad page with a permissive CSP.
 *
 * Static files on Cloudflare Workers (OpenNext) inherit the strict CSP
 * from next.config.js headers(). An API route gives us full control
 * over response headers, ensuring the ad script can use eval() and
 * load images from any source.
 */
export async function GET() {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{display:flex;align-items:center;justify-content:center;
       min-height:100vh;overflow:hidden;background:transparent}
</style>
</head>
<body>
<script src="https://pl28844904.effectivegatecpm.com/68/ce/1d/68ce1d5a90edc273336da9c93f8a8bef.js" async></script>
</body>
</html>`

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      // Permissive CSP — allows Adsterra to eval() and load images from anywhere
      'Content-Security-Policy': [
        "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:",
        "img-src * data: blob: http: https:",
        "script-src * 'unsafe-inline' 'unsafe-eval'",
        "style-src * 'unsafe-inline'",
        "connect-src *",
        "frame-src *",
      ].join('; '),
    },
  })
}
