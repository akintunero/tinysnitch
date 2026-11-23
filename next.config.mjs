/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // These talk to child processes and sockets; keep them out of the bundle.
  serverExternalPackages: ["@modelcontextprotocol/sdk", "@anthropic-ai/sdk", "ajv"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};
