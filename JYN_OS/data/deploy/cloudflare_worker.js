export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const upstreamHost = env.UPSTREAM_HOST || 'jyn-os.svl364.internal';
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }
    url.hostname = upstreamHost;
    const proxyReq = new Request(url.toString(), request);
    const response = await fetch(proxyReq);
    const headers = new Headers(response.headers);
    headers.set('X-Protected-By', 'Cloudflare-Zero-Trust-JYN_OS');
    return new Response(response.body, { status: response.status, headers });
  }
};
