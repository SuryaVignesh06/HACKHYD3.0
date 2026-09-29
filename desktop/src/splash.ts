export const SPLASH_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>FRIDAY</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #101010;
      color: #EDEDED;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      user-select: none;
      -webkit-user-select: none;
      overflow: hidden;
    }
    .card {
      position: relative;
      text-align: center;
      width: 440px;
      padding: 40px 36px;
      border-radius: 26px;
      background: #101010;
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.06),
        inset 0 0 32px rgba(255, 255, 255, 0.015),
        0 30px 80px rgba(0, 0, 0, 0.9);
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    /* Liquid glass rim: a 1px gradient edge, bright where light catches the top-left and bottom-right corners. */
    .card::after {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: inherit;
      padding: 1px;
      pointer-events: none;
      background: linear-gradient(135deg, rgba(255, 255, 255, 0.55), rgba(255, 255, 255, 0.12) 20%, rgba(255, 255, 255, 0.03) 48%, rgba(255, 255, 255, 0.03) 62%, rgba(255, 255, 255, 0.14) 84%, rgba(255, 255, 255, 0.34));
      -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
      -webkit-mask-composite: xor;
      mask-composite: exclude;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 12px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      border-radius: 9999px;
      background: rgba(20, 184, 166, 0.1);
      color: #2DD4BF;
      border: 1px solid rgba(20, 184, 166, 0.25);
      margin-bottom: 20px;
    }
    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #14B8A6;
      box-shadow: 0 0 8px #14B8A6;
      animation: pulse 1.5s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    h1 {
      font-size: 22px;
      font-weight: 700;
      color: #F9FAFB;
      margin-bottom: 8px;
      letter-spacing: -0.02em;
    }
    p.tagline {
      font-size: 13px;
      color: #9CA3AF;
      margin-bottom: 28px;
    }
    .spinner-wrap {
      position: relative;
      width: 44px;
      height: 44px;
      margin-bottom: 24px;
    }
    .spinner-ring {
      position: absolute;
      inset: 0;
      border: 3px solid rgba(255, 255, 255, 0.08);
      border-top-color: #14B8A6;
      border-radius: 50%;
      animation: spin 0.9s cubic-bezier(0.55, 0.15, 0.45, 0.85) infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .status-text {
      font-size: 13px;
      color: #D1D5DB;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      min-height: 20px;
      transition: color 0.2s ease;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge"><span class="dot"></span>Desktop Agent</div>
    <h1>FRIDAY</h1>
    <p class="tagline">Starting backend and frontend services...</p>
    <div class="spinner-wrap">
      <div class="spinner-ring"></div>
    </div>
    <div id="status" class="status-text">Initializing services...</div>
  </div>
</body>
</html>`;
