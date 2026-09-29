export const SPLASH_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>On-Call Copilot</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #000000;
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
      text-align: center;
      width: 440px;
      padding: 40px 36px;
      border-radius: 26px;
      background:
        radial-gradient(140% 90% at 0% 0%, rgba(255, 255, 255, 0.08), transparent 55%),
        linear-gradient(180deg, rgba(255, 255, 255, 0.045), rgba(255, 255, 255, 0.015));
      box-shadow:
        inset 1px 1px 0 rgba(255, 255, 255, 0.22),
        inset -1px -1px 0 rgba(255, 255, 255, 0.07),
        inset 0 0 0 1px rgba(255, 255, 255, 0.06),
        0 30px 80px rgba(0, 0, 0, 0.8);
      display: flex;
      flex-direction: column;
      align-items: center;
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
      background: rgba(59, 130, 246, 0.12);
      color: #60A5FA;
      border: 1px solid rgba(59, 130, 246, 0.25);
      margin-bottom: 20px;
    }
    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #3B82F6;
      box-shadow: 0 0 8px #3B82F6;
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
      border: 3px solid #1F2937;
      border-top-color: #3B82F6;
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
    <h1>On-Call Copilot</h1>
    <p class="tagline">Starting backend and frontend services...</p>
    <div class="spinner-wrap">
      <div class="spinner-ring"></div>
    </div>
    <div id="status" class="status-text">Initializing services...</div>
  </div>
</body>
</html>`;
