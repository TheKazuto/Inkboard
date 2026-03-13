// src/app/api/ad-frame/route.ts
//
// Serve o HTML do banner AdsTerra como uma página isolada.
// Carregado via <iframe> no AdBanner — garante que o script invoke.js
// executa em contexto HTML puro (sem React, sem Next.js), com
// document.currentScript funcionando normalmente.

import { NextResponse } from 'next/server'

const AD_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: transparent;
      display: flex;
      align-items: center;
      justify-content: center;
    }
  </style>
</head>
<body>
  <script async="async" data-cfasync="false" src="https://pl28910513.effectivegatecpm.com/9fff4c2be37c4994f8ffb267b94c0fa6/invoke.js"></script>
  <div id="container-9fff4c2be37c4994f8ffb267b94c0fa6"></div>
</body>
</html>`

export async function GET() {
  return new NextResponse(AD_HTML, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Sem X-Frame-Options nesta rota — o middleware já remove para este path
      // (veja src/middleware.ts)
      'Cache-Control': 'no-store',
    },
  })
}
