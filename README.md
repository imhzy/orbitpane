# Antigravity Web Bridge

A sleek, modern web interface for the **Google Antigravity Agent**, bringing the power of the AGY CLI directly to your browser. Designed with Apple-style aesthetics, fluid motion, and professional productivity in mind.

## 🌟 Key Features

- **Multi-Session Management**: Create multiple conversational contexts. Each session is permanently bound to a specific server directory. The agent operates securely within that boundary.
- **Apple-Style Design System**: 
  - **Glassmorphism**: Translucent drawers and input panels using `backdrop-filter`.
  - **Fluid Motion**: Spring-based physics powered by `framer-motion` for drawer menus, message bubbles, and interactions.
  - **Light Theme (Default)**: Crisp, high-contrast, Mac-native styling using system fonts (Inter / San Francisco).
- **Rich Markdown & Code**: Seamlessly renders the agent's markdown output with proper formatting and `vs-light` syntax highlighting for code blocks.
- **Mobile Responsive**: Fully adaptive layout that automatically collapses the sidebar on narrow screens to maximize the chat view.
- **Persistent Memory**: Chat history is reliably stored in a local SQLite database (`history.db`).

## 🏗️ Architecture

The project is split into two independent domains:

### 1. Frontend (`/frontend`)
- **Framework**: React 18 + Vite
- **Styling**: Vanilla CSS (CSS Variables for theming) + `lucide-react` for SVG icons.
- **Animation**: `framer-motion`
- **Markdown**: `react-markdown`, `remark-gfm`, `react-syntax-highlighter`

### 2. Backend (`/backend`)
- **Framework**: Python 3.11 + FastAPI
- **AI Integration**: `google-antigravity` Python SDK (Using `Gemini 3.6 Flash`)
- **Database**: SQLite3 (`history.db`)
- **Communication**: WebSockets for real-time streaming, REST APIs for filesystem and session management.

## 🚀 Deployment & Management

The application is deployed on a Linux server and served via Nginx over HTTPS.

### Managing the Backend (Python/FastAPI)
The backend is managed as a background daemon using **PM2** to ensure high availability and auto-restarts.

```bash
# Navigate to backend
cd ~/agy_web_bridge/backend

# Start the service with PM2
pm2 start main.py --name "agy-backend" --interpreter python3

# View logs
pm2 logs agy-backend

# Restart or Stop
pm2 restart agy-backend
pm2 stop agy-backend
```
*Note: The backend runs locally on port `8005`. It automatically configures necessary proxies for the Antigravity SDK to bypass network restrictions.*

### Managing the Frontend (React/Vite)
The frontend is built statically and served by Nginx.

```bash
# Navigate to frontend
cd ~/agy_web_bridge/frontend

# Install dependencies
npm install

# Build for production
npm run build
```

### Nginx Configuration
The Nginx server acts as a reverse proxy for both the static files and the WebSocket backend. It mounts the application at `/agy`.

```nginx
location /agy/ {
    alias /root/agy_web_bridge/frontend/dist/;
    index index.html;
    try_files $uri $uri/ /agy/index.html;
}

location /agy/api/ {
    proxy_pass http://127.0.0.1:8005/api/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

## 📂 Project Structure

```text
~/agy_web_bridge/
├── backend/
│   └── main.py          # FastAPI application & Antigravity SDK integration
├── frontend/
│   ├── src/
│   │   ├── App.tsx      # Main React UI, State Management, WebSocket Client
│   │   ├── App.css      # Apple-style Design System
│   │   └── main.tsx     # React Entry
│   ├── index.html
│   └── package.json
├── history.db           # SQLite database (auto-generated)
└── README.md            # You are here
```

## 🛠️ Usage

1. Open `https://your-domain.com/agy` in your browser.
2. Click the hamburger menu in the top left to open the **Sessions Drawer**.
3. Click `+ New Session` and browse your server's file tree to pick a working directory.
4. Name your session and click `Create`.
5. Select the session to instantly connect the Web Socket and begin chatting with the Antigravity Agent!
