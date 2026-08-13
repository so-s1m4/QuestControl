/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (["/api/reception/checkin/visits", "/api/reception/checkin/participants"].includes(url.pathname)) {
      const allowedMethod = url.pathname.endsWith("/visits") ? "GET" : "POST";
      if (request.method !== allowedMethod) return new Response("Method not allowed", { status: 405 });
      const target = new URL(`/api${url.pathname.slice(4)}${url.search}`, "https://quest.s1m4.com");
      const headers = new Headers({ accept: "application/json" });
      const contentType = request.headers.get("content-type");
      if (contentType) headers.set("content-type", contentType);
      const response = await fetch(target, {
        method: request.method,
        headers,
        body: request.method === "POST" ? request.body : undefined,
      });
      const proxied = new Response(response.body, response);
      proxied.headers.set("cache-control", "no-store");
      return proxied;
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
