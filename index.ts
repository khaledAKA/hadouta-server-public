import express, { type Request, Response, NextFunction } from "express";
import cors from "cors";
import { registerRoutes } from "./routes";
import { scheduledDeletionService } from "./services/scheduledDeletionService";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

const app = express();

// Enable CORS for client connections
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:3000',
  credentials: true
}));

// Handle raw body for Stripe webhooks
app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));

// Parse JSON bodies for all other routes
app.use((req, res, next) => {
  if (req.originalUrl === '/api/stripe-webhook') {
    next();
  } else {
    express.json({ limit: '10mb' })(req, res, next);
  }
});

app.use(express.urlencoded({ extended: false, limit: '10mb' }));

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  const server = await registerRoutes(app);

  // Start the scheduled deletion service
  scheduledDeletionService.start();

  // Start client application in production mode
  if (process.env.NODE_ENV === 'production') {
    const clientProcess = spawn('npm', ['run', 'build'], {
      cwd: path.resolve(__dirname, '../client'),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      detached: false,
      env: { ...process.env, PATH: process.env.PATH }
    });

    clientProcess.stdout.on('data', (data) => {
      log(`${data.toString().trim()}`, 'client');
    });

    clientProcess.stderr.on('data', (data) => {
      log(`${data.toString().trim()}`, 'client');
    });

    clientProcess.on('error', (err) => {
      log(`Failed to build client: ${err.message}`, 'client');
    });

    clientProcess.on('exit', (code) => {
      if (code === 0) {
        log('Client build completed successfully', 'client');
        // Start production server
        const serverProcess = spawn('npm', ['run', 'start'], {
          cwd: path.resolve(__dirname, '../client'),
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: true,
          detached: false,
          env: { ...process.env, PATH: process.env.PATH, NODE_ENV: 'production' }
        });

        serverProcess.stdout.on('data', (data) => {
          log(`${data.toString().trim()}`, 'client');
        });

        serverProcess.stderr.on('data', (data) => {
          log(`${data.toString().trim()}`, 'client');
        });

        // Cleanup on exit
        process.on('SIGINT', () => {
          serverProcess.kill('SIGTERM');
        });

        process.on('SIGTERM', () => {
          serverProcess.kill('SIGTERM');
        });
      } else {
        log(`Client build failed with code ${code}`, 'client');
      }
    });
  }

  // Add a proxy to the client application for non-API routes
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      // Proxy to client application on port 3000
      res.redirect(`http://localhost:3000${req.path}`);
    }
  });

  const port = process.env.PORT || 5001;
  server.listen(port, () => {
    log(`serving on port ${port}`);
    log(`API endpoints available on port ${port}`);
    if (process.env.NODE_ENV === 'development') {
      log(`Starting client application on port 3000`);
    }
  });
})();
